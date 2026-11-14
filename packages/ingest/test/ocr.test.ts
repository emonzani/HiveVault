import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "@cb/blobs";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL, MOCK_OCR_MODEL, splitOcrPages } from "@cb/models";
import { parseFile, renderPdfPages } from "@cb/parsers";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { Compiler, defineIngestTask, IngestService, mergeOcr, SourceStore, type OcrDeps } from "../src/index.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-ocr-"));

const ocrEndpoint = new MockEndpoint({ kind: "ocr", id: "mock-ocr", slots: 1 });
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
await dispatcher.addEndpoint(new MockEndpoint({ kind: "chat" }));
await dispatcher.addEndpoint(ocrEndpoint);

const rendered: number[][] = [];
/** Images of this size are refused by the "model" (a type or a page it cannot read). */
let refuseBytes = -1;
const ocr: OcrDeps = {
  render: async (data, pages) => (rendered.push(pages), renderPdfPages(data, pages, 1)),
  read: async (images, priority) => {
    if (images.some((i) => i.data.length === refuseBytes)) throw new Error("HTTP 400 image not supported");
    return dispatcher.ocr({ images }, { priority: priority as 0 | 1 | 2 });
  },
  ready: () => ocrEndpoint.up,
  pagesPerRequest: 2,
  maxPages: 3,
};

const store = sql ? new SourceStore(sql, new FsBlobStore(path.join(tmp, "blobs"), randomBytes(32))) : undefined;
const search = sql ? new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }) : undefined;
const task = sql
  ? defineIngestTask({
      store: store!,
      parse: (d, n) => parseFile(d, n),
      indexer: () => new EmbeddingIndexer(sql, dispatcher, { model: MOCK_EMBED_MODEL }),
      compiler: new Compiler(sql, store!, new PageStore(sql), search!, dispatcher),
      chunk: { minTokens: 1 },
      name: `ingest-ocr-${run}`,
      ocr: () => ocr,
    })
  : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50, concurrency: 4 }).register(task!) : undefined;
const service = sql ? new IngestService(sql, store!, engine!, task!, undefined, { compileUploads: false }) : undefined;
await engine?.start();

afterAll(async () => {
  await engine?.stop();
  dispatcher.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

/** A small grey PNG: a "scanned" page has an image and no text layer. */
const canvas = createCanvas(40, 20);
canvas.getContext("2d").fillRect(5, 5, 30, 10);
const PNG = canvas.toBuffer("image/png");

/** Five pages: 1, 3, 4, 5 scans (an image only), 2 with a text layer. */
function scannedPdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A5", autoFirstPage: false });
    const parts: Buffer[] = [];
    doc.on("data", (b: Buffer) => parts.push(b));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    for (let p = 1; p <= 5; p++) {
      doc.addPage();
      if (p === 2) doc.text(`Pagina di testo vero ${run}: il contratto di fornitura scade il 30 giugno e si rinnova per un anno.`);
      else doc.image(PNG, 50, 50, { width: 200 });
    }
    doc.end();
  });
}

async function settle(vaultId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const [r] = await sql!<{ open: number }[]>`
      select count(*)::int as open from sources s join tasks t on t.id = s.task_id
      where s.vault_id = ${vaultId} and t.status not in ('done', 'failed', 'cancelled')`;
    if (r!.open === 0) return;
    if (Date.now() > end) throw new Error("ingestion did not finish");
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe("OCR text", () => {
  it("cuts the model output at the page markers and removes OCR special tokens", () => {
    expect(splitOcrPages("<PAGE>uno<|ref|>x<|/ref|><|det|>[[1,2,3,4]]<|/det|>\n<PAGE>due", 2)).toEqual(["unox", "due"]);
    expect(splitOcrPages("senza marcatori", 2)).toEqual(["senza marcatori", ""]);
    expect(splitOcrPages("<PAGE>a<PAGE>b<PAGE>c", 2)).toEqual(["a", "b\n\nc"]);
  });

  it("puts the OCR pages between the text pages, in page order", () => {
    const md = "## Pagina 2\n\nTesto vero.\n\n## Pagina 4\n\nx";
    const out = mergeOcr(md, new Map([[1, "Primo"], [4, "Quarta pagina letta"], [3, ""]]), true);
    expect(out).toBe("## Pagina 1\n\nPrimo\n\n## Pagina 2\n\nTesto vero.\n\n## Pagina 4\n\nQuarta pagina letta");
    expect(mergeOcr("Immagine", new Map([[1, "Scritta"]]), false)).toBe("Scritta");
  });
});

describe("OCR in the ingestion pipeline", () => {
  db()("reads the scanned pages of a PDF in groups and keeps the text layer of the others", async () => {
    const v = await new VaultStore(sql!, DIMS).create({ kind: "cell", slug: `ocr-pdf-${run}`, name: "ocr" });
    const r = await service!.upload(v.id, await scannedPdf(), "scansione.pdf", null);
    await settle(v.id);
    const s = (await store!.get(r.source.id))!;
    expect(s).toMatchObject({ level: 2, status: "embedded" });
    // 4 scans, at most 3 read (maxPages), 2 per request
    expect(rendered).toContainEqual([1, 3]);
    expect(rendered).toContainEqual([4]);
    expect(s.meta).toMatchObject({ ocr: { model: MOCK_OCR_MODEL, pages: 3 }, warnings: ["ocr_truncated"] });
    const md = (await store!.readBlob(v.id, s.extractedSha!)).toString("utf8");
    expect(md).toMatch(/^## Pagina 1\n\nTesto riconosciuto 1 di 2 \(image\/png/);
    expect(md).toContain(`## Pagina 2\n\nPagina di testo vero ${run}`);
    expect(md).toContain("## Pagina 4\n\nTesto riconosciuto 1 di 1");
    expect(md).not.toContain("## Pagina 5");
    const hit = await search!.search({ id: "u", vaults: [v.id], clearance: 3 }, "Testo riconosciuto");
    expect(hit.hits[0]?.id).toBe(r.source.id);
  }, 60_000);

  db()("reads a photo, and waits while the OCR model does not answer", async () => {
    const v = await new VaultStore(sql!, DIMS).create({ kind: "cell", slug: `ocr-img-${run}`, name: "ocr" });
    ocrEndpoint.up = false;
    const r = await service!.upload(v.id, PNG, "lavagna.png", null);
    // the task sleeps in the OCR phase instead of failing
    for (let i = 0; i < 50; i++) {
      const [t] = await sql!<{ phase: string; status: string }[]>`select t.phase, t.status from tasks t join sources s on s.task_id = t.id where s.id = ${r.source.id}`;
      if (t?.phase === "ocr" && t.status === "sleeping") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const [t] = await sql!<{ phase: string; status: string }[]>`select t.phase, t.status from tasks t join sources s on s.task_id = t.id where s.id = ${r.source.id}`;
    expect(t).toMatchObject({ phase: "ocr", status: "sleeping" });
    ocrEndpoint.up = true;
    await sql!`update tasks set run_after = now() where id = (select task_id from sources where id = ${r.source.id})`;
    await settle(v.id);
    const s = (await store!.get(r.source.id))!;
    expect(s.level).toBe(2);
    expect((await store!.readBlob(v.id, s.extractedSha!)).toString("utf8")).toBe(`Testo riconosciuto 1 di 1 (image/png, ${PNG.length} byte).`);
    expect(s.meta.warnings).toEqual([]);
  }, 60_000);

  db()("an image the model always refuses still reaches I2, marked ocr_failed", async () => {
    const v = await new VaultStore(sql!, DIMS).create({ kind: "cell", slug: `ocr-bad-${run}`, name: "ocr" });
    const c2 = createCanvas(30, 30);
    c2.getContext("2d").fillRect(1, 1, 9, 9);
    const img = c2.toBuffer("image/png");
    refuseBytes = img.length;
    const r = await service!.upload(v.id, img, "illeggibile.png", null);
    // retries wait 1 s, 2 s: bring them forward
    for (let i = 0; i < 100; i++) {
      await sql!`update tasks set run_after = now() where id = (select task_id from sources where id = ${r.source.id}) and status = 'queued'`;
      const [s] = await sql!<{ level: number }[]>`select level from sources where id = ${r.source.id}`;
      if (s!.level >= 2) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    refuseBytes = -1;
    const s = (await store!.get(r.source.id))!;
    expect(s).toMatchObject({ level: 2, status: "embedded" });
    expect(s.meta.warnings).toEqual(["ocr_failed", "no_text"]);
    expect(s.meta.ocr).toMatchObject({ failed: 1 });
  }, 60_000);
});
