import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "@cb/blobs";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL, type ChatRequest } from "@cb/models";
import { parseFile } from "@cb/parsers";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { generateFormats } from "../../../bench/corpus/formats.ts";
import { Compiler, defineIngestTask, fetchLink, IngestService, LinkError, SourceStore } from "../src/index.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-ingest-"));
const corpus = path.join(tmp, "corpus");
await generateFormats(corpus, 1, 21);

// Scripted "model": reads the source, sends a call with broken JSON arguments, searches,
// writes one page without citation (refused), then a correct entity page citing chunk 0 of the source.
let scriptCalls = 0;
const chat = new MockEndpoint({
  kind: "chat",
  id: "scripted",
  script: (req: ChatRequest, turn: number) => {
    scriptCalls++;
    // like llama-server: the arguments of earlier tool calls must be valid JSON
    for (const m of req.messages) for (const c of m.tool_calls ?? []) JSON.parse(c.function.arguments);
    const srcId = /Nuova sorgente (src_\w+)/.exec(req.messages[1]!.content)![1]!;
    const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `c${turn}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
    switch (turn % 6) {
      case 0:
        return call("source_read", { part: 0 });
      case 1:
        return { toolCalls: [{ id: `c${turn}`, type: "function" as const, function: { name: "wiki_write", arguments: '{"markdown": "---\ntitle: Tronca' } }] };
      case 2:
        return call("wiki_search", { query: "Alpi Sanità" });
      case 3:
        return call("wiki_write", { markdown: "---\ntitle: Pagina senza fonti\ntype: concept\n---\n## Stato attuale\n- Un fatto senza citazione." });
      case 4:
        return call("wiki_write", {
          markdown: `---\ntitle: Cliente ${run}\ntype: entity/company\ntldr: Cliente citato nella sorgente.\n---\n## Stato attuale\n- Ha un contratto attivo ^[${srcId}#c0]\n\n## Timeline\n- 2026-02-01 · Rinnovo discusso ^[${srcId}#c0]`,
        });
      default:
        return { content: "FINE" };
    }
  },
});
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
await dispatcher.addEndpoint(chat);

const blobs = new FsBlobStore(path.join(tmp, "blobs"), randomBytes(32));
const store = sql ? new SourceStore(sql, blobs) : undefined;
const search = sql ? new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }) : undefined;
const pages = sql ? new PageStore(sql) : undefined;
const compiler = sql ? new Compiler(sql, store!, pages!, search!, dispatcher, { useModel: "always", mode: "agent" }) : undefined;
const task = sql
  ? defineIngestTask({ store: store!, parse: (d, n) => parseFile(d, n), indexer: () => new EmbeddingIndexer(sql, dispatcher, { model: MOCK_EMBED_MODEL }), compiler: compiler!, chunk: { minTokens: 1 }, name: `ingest-pipe-${run}` })
  : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50, concurrency: 8 }).register(task!) : undefined;
const service = sql ? new IngestService(sql, store!, engine!, task!, undefined, { compileUploads: false, demandThreshold: 2 }) : undefined;
await engine?.start();

afterAll(async () => {
  await engine?.stop();
  dispatcher.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const vault = async (slug: string) => new VaultStore(sql!, DIMS).create({ kind: "space", slug: `${slug}-${run}`, name: slug });

/** Waits until a source and all its descendants have finished their task. */
async function settle(vaultId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const [r] = await sql!<{ open: number }[]>`
      select count(*)::int as open from sources s join tasks t on t.id = s.task_id
      where s.vault_id = ${vaultId} and t.status not in ('done', 'failed', 'cancelled')`;
    const [u] = await sql!<{ n: number }[]>`select count(*)::int as n from sources where vault_id = ${vaultId} and task_id is null`;
    if (r!.open === 0 && u!.n === 0) return;
    if (Date.now() > end) throw new Error("ingestion did not finish");
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe("ingestion pipeline", () => {
  db()("ingests one file of every format: I2 reached, children created, unsupported marked", async () => {
    const v = await vault("ing-all");
    const formats = ["md", "txt", "csv", "docx", "xlsx", "pptx", "pdf", "eml", "html", "code", "zip", "image", "mbox"];
    const ext: Record<string, string> = { md: "nota-0.md", txt: "appunti-0.txt", csv: "ordini-0.csv", docx: "analisi-0.docx", xlsx: "listino-0.xlsx", pptx: "stato-0.pptx", pdf: "verbale-0.pdf", eml: "messaggio-0.eml", html: "pagina-0.html", code: "servizio-0.ts", zip: "archivio-0.zip", image: "scansione-0.png", mbox: "casella-0.mbox" };
    for (const f of formats) await service!.upload(v.id, await readFile(path.join(corpus, f, ext[f]!)), ext[f]!, null);
    await service!.upload(v.id, Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 9]), "dati.bin", null);
    await settle(v.id);

    const rows = await sql!<{ name: string; status: string; level: number; origin: string; parent: string | null }[]>`
      select name, status, level, origin, parent_id as parent from sources where vault_id = ${v.id} order by name`;
    const top = rows.filter((r) => r.origin === "upload");
    expect(top.filter((r) => r.name !== "dati.bin").every((r) => r.level === 2 && r.status === "embedded")).toBe(true);
    expect(top.find((r) => r.name === "dati.bin")).toMatchObject({ status: "unsupported", level: 0 });
    const children = rows.filter((r) => r.origin === "attachment");
    // eml: 1 attachment, zip: 2 members, mbox: 5 messages
    expect(children).toHaveLength(8);
    expect(children.every((c) => c.level === 2)).toBe(true);
    const [{ n }] = (await sql!`select count(*)::int as n from chunks where vault_id = ${v.id} and embedding is null`) as unknown as [{ n: number }];
    expect(n).toBe(0);
    const log = await sql!<{ kind: string }[]>`select kind from vault_log where vault_id = ${v.id}`;
    expect(log.filter((l) => l.kind === "ingest").length).toBeGreaterThanOrEqual(21);
  }, 120_000);

  db()("the content is searchable at once and the original stays encrypted on disk", async () => {
    const v = await vault("ing-search");
    const r = await service!.upload(v.id, Buffer.from(`# Verbale ${run}\n\nIl progetto Zeffiro-${run} ha una consegna il 12 marzo.`), "verbale.md", null);
    await settle(v.id);
    const s = await search!.search({ id: "u", vaults: [v.id], clearance: 3 }, `Zeffiro-${run} consegna`);
    expect(s.hits[0]).toMatchObject({ kind: "source", id: r.source.id, level: "I2" });
    const raw = await readFile(path.join(tmp, "blobs", v.id, r.source.sha256.slice(0, 2), r.source.sha256.slice(2, 4), r.source.sha256));
    expect(raw.includes(Buffer.from("Zeffiro"))).toBe(false);
  });

  db()("emails are at least riservato with their attachments; switched off, they stop as unsupported", async () => {
    const v = await vault("ing-mail");
    const eml = await readFile(path.join(corpus, "eml", "messaggio-0.eml"));
    const r = await service!.upload(v.id, eml, "messaggio-0.eml", null, { classification: 1 });
    await settle(v.id);
    const rows = await sql!<{ origin: string; classification: number }[]>`select origin, classification from sources where vault_id = ${v.id} order by origin`;
    expect(rows).toEqual([{ origin: "attachment", classification: 2 }, { origin: "upload", classification: 2 }]);
    const chunks = await sql!<{ c: number }[]>`select distinct classification as c from chunks where vault_id = ${v.id}`;
    expect(chunks).toEqual([{ c: 2 }]);
    expect(r.source.id).toBeTruthy();

    // email off (console setting): the pipeline refuses the file
    const off = defineIngestTask({ store: store!, parse: (d, n) => parseFile(d, n), indexer: () => null, compiler: compiler!, email: () => false, name: `ingest-nomail-${run}` });
    const engine2 = new TaskEngine(sql!, { pollMs: 50 }).register(off);
    await engine2.start();
    try {
      const w = await vault("ing-nomail");
      const svc = new IngestService(sql!, store!, engine2, off, undefined, { compileUploads: false });
      const s = await svc.upload(w.id, eml, "messaggio-0.eml", null);
      await settle(w.id);
      expect(await store!.get(s.source.id)).toMatchObject({ status: "unsupported", error: expect.stringContaining("email") });
      expect(await sql!`select 1 from sources where parent_id = ${s.source.id}`).toHaveLength(0);
    } finally {
      await engine2.stop();
    }
  });

  db()("the same file twice is one source", async () => {
    const v = await vault("ing-dedup");
    const a = await service!.upload(v.id, Buffer.from("stesso contenuto " + run), "a.txt", null);
    const b = await service!.upload(v.id, Buffer.from("stesso contenuto " + run), "copia.txt", null);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, source: { id: a.source.id } });
  });

  db()("compiles a source: extractive page + model pages, a page without citations is refused", async () => {
    const v = await vault("ing-compile");
    scriptCalls = 0;
    const r = await service!.upload(v.id, await readFile(path.join(corpus, "eml", "messaggio-0.eml")), "messaggio-0.eml", null, { compile: true });
    await settle(v.id);
    const src = (await store!.get(r.source.id))!;
    expect(src).toMatchObject({ level: 3, status: "compiled" });
    const sp = (await PageStore.get(sql!, src.compiledPage!))!;
    expect(sp.type).toBe("source");
    expect(sp.body).toContain(`^[${src.id}#c0]`);
    expect(sp.body).toMatch(/## Metadati[\s\S]*- Da: /);
    const entity = await sql!<{ title: string; body: string }[]>`select title, body from pages where vault_id = ${v.id} and type = 'entity/company'`;
    expect(entity).toHaveLength(1);
    // the email and its attachment are both compiled: the last one wrote the entity page
    const cited = /\^\[(src_\w+)#c0\]/.exec(entity[0]!.body)![1]!;
    const family = await sql!<{ id: string }[]>`select id from sources where id = ${src.id} or parent_id = ${src.id}`;
    expect(family.map((f) => f.id)).toContain(cited);
    const refused = await sql!`select 1 from pages where vault_id = ${v.id} and title = 'Pagina senza fonti'`;
    expect(refused).toHaveLength(0);
    expect(scriptCalls).toBeGreaterThanOrEqual(6);
    // the attachment of the email was compiled too (it inherits the flag)
    const child = await sql!<{ level: number }[]>`select level from sources where parent_id = ${src.id}`;
    expect(child.every((c) => c.level === 3)).toBe(true);
  }, 60_000);

  db()("a reingest that extracts the same text skips the model (M20); the queue knows the time of a compile (M14)", async () => {
    const v = await vault("ing-same");
    const r = await service!.upload(v.id, Buffer.from(`# Nota ${run}\n\nIl fornitore Gamma ${run} consegna ogni martedì.`), `nota-${run}.md`, null, { compile: true });
    await settle(v.id);
    const first = (await store!.get(r.source.id))!;
    expect(first).toMatchObject({ level: 3, status: "compiled" });
    expect(first.meta).toMatchObject({ compiledWith: "agent", compiledSha: first.extractedSha, compileMs: expect.any(Number) });
    const q = await service!.compileQueue();
    expect(q.measured).toBeGreaterThanOrEqual(1);
    expect(q.secondsPerSource).not.toBeNull();
    expect(q.waitMinutes).toBe(Math.ceil((q.waiting * q.secondsPerSource!) / 60));

    const calls = scriptCalls;
    await service!.reingest(r.source.id);
    await settle(v.id);
    expect(await store!.get(r.source.id)).toMatchObject({ level: 3, status: "compiled", compiledPage: first.compiledPage });
    expect(scriptCalls).toBe(calls);
    const [log] = await sql!<{ data: { unchanged?: boolean } }[]>`select data from vault_log where vault_id = ${v.id} and kind = 'compile' order by id desc limit 1`;
    expect(log!.data.unchanged).toBe(true);
  }, 60_000);

  db()("a compile gives its worker back while the chat model is busy; a deleted source ends the task", async () => {
    // own task and engine: the chat model is "busy" until the test says otherwise
    let busy = true;
    const t2 = defineIngestTask({
      store: store!, parse: (d, n) => parseFile(d, n), indexer: () => null, compiler: compiler!, chunk: { minTokens: 1 },
      name: `ingest-busy-${run}`, chatBusy: () => busy, compileRetryMs: 200,
    });
    const e2 = new TaskEngine(sql!, { pollMs: 50, concurrency: 2 }).register(t2);
    await e2.start();
    try {
      const svc = new IngestService(sql!, store!, e2, t2, undefined, { compileUploads: true });
      const v = await vault("ing-busy");
      const state = async (id: string) =>
        (await sql!<{ status: string; phase: string; error: string | null; attempts: number }[]>`select status, phase, error, attempts from tasks where id = ${id}`)[0]!;
      const until = async (id: string, ok: (x: Awaited<ReturnType<typeof state>>) => boolean) => {
        for (let i = 0; i < 300; i++) {
          const x = await state(id);
          if (ok(x)) return x;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`task ${id}: ${JSON.stringify(await state(id))}`);
      };

      const a = await svc.upload(v.id, Buffer.from("# Nota\n\nRinnovo del contratto con il cliente Alfa per 40 postazioni."), "nota.md", null, { compile: true });
      // I1 is reached; then the task waits in the compile phase without holding a worker
      const sleeping = await until(a.taskId!, (x) => x.phase === "compile" && x.status === "sleeping");
      expect(sleeping.attempts).toBe(0);
      expect((await store!.get(a.source.id))!.level).toBe(1);
      // a second document is read meanwhile: the busy chat model does not block it
      const b = await svc.upload(v.id, Buffer.from("# Altra nota\n\nTesto breve."), "altra.md", null, { compile: false });
      await until(b.taskId!, (x) => x.status === "done");

      busy = false;
      await until(a.taskId!, (x) => x.status === "done");
      expect((await store!.get(a.source.id))!).toMatchObject({ level: 3, status: "compiled" });

      // the source goes away while its compile waits: the task ends with a clear error
      busy = true;
      const c = await svc.upload(v.id, Buffer.from("# Terza\n\nDa eliminare prima della compilazione."), "terza.md", null, { compile: true });
      await until(c.taskId!, (x) => x.phase === "compile" && x.status === "sleeping");
      await sql!`delete from chunks where source_id = ${c.source.id}`;
      await sql!`delete from sources where id = ${c.source.id}`;
      busy = false;
      expect(await until(c.taskId!, (x) => x.status === "failed")).toMatchObject({ phase: "compile", error: "source deleted" });
    } finally {
      await e2.stop();
    }
  });

  db()("compiles on demand after repeated search hits", async () => {
    const v = await vault("ing-demand");
    const r = await service!.upload(v.id, Buffer.from(`Relazione sul fornitore Vortice-${run}: consegne puntuali.`), "relazione.txt", null);
    await settle(v.id);
    const hit = { kind: "source" as const, id: r.source.id, level: "I2" as const };
    await service!.onSearchHits([hit]);
    expect((await store!.get(r.source.id))!.level).toBe(2);
    await service!.onSearchHits([hit]);
    await settle(v.id);
    expect((await store!.get(r.source.id))!).toMatchObject({ level: 3, compile: true });
  }, 60_000);
});

describe("links", () => {
  it("refuses links to the internal network (SSRF), credentials and other schemes", async () => {
    await expect(fetchLink("http://127.0.0.1:8000/", undefined)).rejects.toBeInstanceOf(LinkError);
    await expect(fetchLink("http://192.168.1.10:8000/v1/models", undefined)).rejects.toThrow(/rete interna/);
    await expect(fetchLink("file:///etc/passwd", undefined)).rejects.toThrow(/http e https/);
    await expect(fetchLink("http://user:pw@example.com/", undefined)).rejects.toThrow(/credenziali/);
  });

  db()("downloads a page (local test server) and follows a redirect", async () => {
    const server = http.createServer((q, s) => {
      if (q.url === "/vecchio") {
        s.writeHead(301, { location: "/articolo" });
        return s.end();
      }
      s.writeHead(200, { "content-type": "text/html" });
      s.end(`<html><head><title>Articolo ${run}</title></head><body><article><h1>Articolo</h1><p>${"Contenuto importante dell'articolo. ".repeat(20)}</p></article></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const f = await fetchLink(`http://127.0.0.1:${port}/vecchio`, undefined, { allowPrivate: true });
    expect(f.url).toBe(`http://127.0.0.1:${port}/articolo`);
    expect(f.name).toBe("articolo.html");
    await new Promise((r) => server.close(r));
  });
});
