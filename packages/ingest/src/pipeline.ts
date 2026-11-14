/**
 * Ingestion pipeline (plan §4.1–4.2) as a durable task, one per source:
 *
 *   parse    L0 -> L1 Markdown (worker thread), stored encrypted; attachments -> child sources
 *   ocr      scans only: page images read by the OCR model, a few pages per step  -> L1
 *   index    chunks + full-text                                   -> level I1 (searchable)
 *   embed    vectors of the chunks (CPU model, background)        -> level I2
 *   compile  source page + model agent (only sources to compile)  -> level I3
 *
 * Every phase commits a checkpoint. A crash continues from the last phase; every phase is
 * idempotent (content-addressed blobs, chunk replacement, page upsert by path), so a phase
 * that ran twice leaves the same result.
 */
import type { EmbeddingIndexer } from "@cb/brain";
import type { ParseResult } from "@cb/parsers";
import { detectLang, UnsupportedFormatError } from "@cb/parsers";
import { createLogger, metrics } from "@cb/shared";
import { defineTask, type TaskDefinition } from "@cb/tasks";
import type { Compiler } from "./compiler.ts";
import { MAX_DEPTH, type Source, type SourceStore } from "./sources.ts";

const log = createLogger("ingest");

/** OCR of scans: images, and PDF pages without a text layer. */
export interface OcrDeps {
  /** PNG images of PDF pages (1-based numbers). */
  render(data: Buffer, pages: number[]): Promise<Buffer[]>;
  /** Text of page images, in order (the model dispatcher, kind "ocr"). */
  read(images: { data: Buffer; mime: string }[], priority: number): Promise<{ pages: string[]; model: string }>;
  /** False while no OCR endpoint answers: the phase gives its worker back and waits. */
  ready(): boolean;
  /** Pages read together in one request. */
  pagesPerRequest: number;
  /** Scanned pages read per document at most. */
  maxPages: number;
}

export interface PipelineDeps {
  store: SourceStore;
  parse: (data: Buffer, name: string) => Promise<ParseResult>;
  /** null when no embedding model is configured: sources stop at I1. */
  indexer: () => EmbeddingIndexer | null;
  compiler: Compiler;
  /** Chunk sizes; default from the plan (300–800 tokens). */
  chunk?: { targetTokens?: number; maxTokens?: number; minTokens?: number };
  /** Task name (default "ingest-source"). Tests sharing one database use unique names. */
  name?: string;
  /**
   * True while every chat endpoint is busy. The compile phase then gives its worker back and
   * tries again later: a compile waiting for the one chat slot must not hold a worker that new
   * documents need for I1 and I2. Without it (or without chat endpoints) the phase runs at once.
   */
  chatBusy?: () => boolean;
  /**
   * First pause of a compile that gave its worker back (default 15 s). The pause doubles at
   * every new wait, up to 8 times the first: a long compile does not fill the task journal.
   */
  compileRetryMs?: number;
  /**
   * OCR, or null when no OCR endpoint is configured: scans keep the warning "needs_ocr" and
   * the dream cycle reads them again when an OCR endpoint is added.
   */
  ocr?: () => OcrDeps | null;
  /**
   * Email files (EML, MSG, MBOX) allowed (console setting, default true). Off: they stop as
   * "unsupported". On: they are at least "riservato", never read by the cloud agent: a mailbox
   * holds the correspondence of people outside the company.
   */
  email?: () => boolean;
}

/** Parsers of email files. */
export const EMAIL_PARSERS = new Set(["eml", "msg", "mbox"]);
/** Lowest classification of an email and of its attachments: riservato. */
export const EMAIL_MIN_CLASSIFICATION = 2;

interface OcrState {
  /** Page numbers to read (1 for an image). */
  pages: number[];
  /** Pages read so far. */
  done: number;
  /** Blobs with the text of each step: [page, text][] (the task state stays small). */
  parts: string[];
  model?: string;
  truncated?: boolean;
  waits?: number;
  /** Pages the model could not read after 3 tries (broken page, image type refused). */
  failed?: number;
}

interface State {
  lang?: string;
  children?: number;
  /** Times the compile phase gave its worker back because the chat model was busy. */
  compileWaits?: number;
  ocr?: OcrState;
}

/**
 * The parser Markdown with the OCR text of the scanned pages. PDF: one "## Pagina N" section per
 * page, in page order (pages with a text layer keep it). Image: the OCR text only.
 */
export function mergeOcr(markdown: string, text: Map<number, string>, pdf: boolean): string {
  if (!pdf) return text.get(1) ?? "";
  const pages = new Map<number, string>();
  // the parser writes "## Pagina N" at the start of a line, page text never starts with it
  for (const part of markdown.split(/^(?=## Pagina \d+$)/m)) {
    const m = /^## Pagina (\d+)\n([\s\S]*)$/.exec(part);
    if (m) pages.set(Number(m[1]), m[2]!.trim());
  }
  for (const [p, t] of text) if (t && (pages.get(p) ?? "").length < t.length) pages.set(p, t);
  return [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, t]) => t)
    .map(([p, t]) => `## Pagina ${p}\n\n${t}`)
    .join("\n\n");
}

export type IngestTask = TaskDefinition<{ sourceId: string }, State, { level: number; status: string }>;

/** Errors that will not go away with a retry: the source is marked and the task ends. */
function permanent(e: unknown): boolean {
  return e instanceof UnsupportedFormatError || /Formato non supportato|password|encrypted|corrupt|Invalid PDF|End of central directory/i.test(String((e as Error)?.message ?? e));
}

export function defineIngestTask(d: PipelineDeps): IngestTask {
  const task: IngestTask = defineTask<{ sourceId: string }, State, { level: number; status: string }>({
    name: d.name ?? "ingest-source",
    version: 1,
    firstPhase: "parse",
    maxAttempts: 6,
    initial: () => ({}),
    phases: {
      parse: async (c) => {
        const src = await d.store.get(c.task.input.sourceId);
        if (!src) return c.fail("source deleted");
        await d.store.update(src.id, { task_id: c.task.id });
        let r: ParseResult;
        try {
          r = await d.parse(await d.store.readBlob(src.vaultId, src.sha256), src.name);
        } catch (e) {
          if (permanent(e) || c.task.attempts >= 3) {
            const status = e instanceof UnsupportedFormatError ? "unsupported" : "failed";
            metrics.inc("ingest_parsed", { format: (src.name.split(".").pop() ?? "?").toLowerCase().slice(0, 8), outcome: status });
            await d.store.update(src.id, { status, error: String((e as Error).message ?? e).slice(0, 500) });
            await d.store.log(src.vaultId, "ingest", `${src.name}: ${status}`, src.id, undefined, src.classification);
            return c.done({ level: 0, status });
          }
          throw e;
        }
        if (EMAIL_PARSERS.has(r.parser)) {
          if (d.email && !d.email()) {
            metrics.inc("ingest_parsed", { format: r.parser, outcome: "unsupported" });
            await d.store.update(src.id, { status: "unsupported", error: "L'acquisizione delle email è disattivata dagli amministratori." });
            await d.store.log(src.vaultId, "ingest", `${src.name}: unsupported`, src.id, undefined, src.classification);
            return c.done({ level: 0, status: "unsupported" });
          }
          if (src.classification < EMAIL_MIN_CLASSIFICATION) {
            await d.store.setClassification(src.id, EMAIL_MIN_CLASSIFICATION);
            src.classification = EMAIL_MIN_CLASSIFICATION; // attachments inherit it below
          }
        }
        metrics.inc("ingest_parsed", { format: r.parser, outcome: "ok" });
        metrics.inc("ingest_bytes", { format: r.parser }, src.size);
        const extracted = await d.store.blobs.put(src.vaultId, r.markdown);
        await d.store.update(
          src.id,
          {
            mime: r.mime,
            parser_version: `${r.parser}@${r.parserVersion}`,
            title: (r.title ?? src.title ?? null)?.slice(0, 300) ?? null,
            extracted_sha: extracted.sha256,
            text_tokens: Math.ceil(r.markdown.length / 3.6),
            status: "parsed",
            error: null,
          },
          { ...r.meta, warnings: r.warnings, lang: r.lang },
        );
        // attachments, archive members, mailbox messages: child sources with their own task
        let children = 0;
        if (r.attachments.length) {
          const depth = await d.store.depth(src.id);
          if (depth >= MAX_DEPTH) {
            await d.store.update(src.id, {}, { warnings: [...r.warnings, "max_depth"] });
          } else {
            for (const [i, a] of r.attachments.entries()) {
              const child = await d.store.create(a.data, {
                vaultId: src.vaultId,
                name: a.name,
                origin: "attachment",
                parentId: src.id,
                classification: src.classification,
                priority: src.priority,
                compile: src.compile,
                createdBy: src.createdBy,
              });
              // also when the child exists already: a crash may have hit between create and spawn.
              // spawn is idempotent (stable request id); children of another parent are skipped.
              if (child.created || child.source.parentId === src.id) {
                await c.spawn(task, `child:${i}`, { sourceId: child.source.id }, { priority: Math.min(2, src.priority + 1) });
                children++;
              }
            }
          }
        }
        const ocr = d.ocr?.();
        if (ocr && (r.warnings.includes("needs_ocr") || r.warnings.includes("ocr_unavailable"))) {
          const total = Number(r.meta.pages ?? 1);
          const all = r.parser === "image" ? [1] : ((r.meta.scanPages as number[] | undefined) ?? Array.from({ length: total }, (_, i) => i + 1));
          const pages = all.slice(0, ocr.maxPages);
          return c.next("ocr", { lang: r.lang, children, ocr: { pages, done: 0, parts: [], truncated: pages.length < all.length } });
        }
        return c.next("index", { lang: r.lang, children });
      },

      ocr: async (c) => {
        const src = await d.store.get(c.task.input.sourceId);
        if (!src) return c.fail("source deleted");
        const { ocr: st, ...rest } = c.task.state;
        const ocr = d.ocr?.();
        // no OCR endpoint any more: index the text layer, the warning stays
        if (!st || !ocr) return c.next("index", rest);
        if (st.done < st.pages.length) {
          if (!ocr.ready()) {
            const waits = (st.waits ?? 0) + 1;
            return c.sleepUntil(new Date(Date.now() + Math.min(60, 5 * waits) * 60_000), "ocr", { ...rest, ocr: { ...st, waits } });
          }
          const batch = st.pages.slice(st.done, st.done + ocr.pagesPerRequest);
          const data = await d.store.readBlob(src.vaultId, src.sha256);
          const pdf = src.mime === "application/pdf";
          let r: { pages: string[]; model: string };
          let failed = st.failed ?? 0;
          try {
            const images = pdf ? (await ocr.render(data, batch)).map((b) => ({ data: b, mime: "image/png" })) : [{ data, mime: src.mime }];
            r = await ocr.read(images, src.priority);
          } catch (e) {
            // the document must still reach I1 with its text layer: after 3 tries the group stays without OCR
            if (c.task.attempts < 3) throw e;
            log.warn("ocr failed", { source: src.id, pages: batch.join(","), error: String((e as Error).message ?? e).slice(0, 300) });
            r = { pages: [], model: st.model ?? "" };
            failed += batch.length;
          }
          metrics.inc("ingest_ocr_pages", { outcome: failed > (st.failed ?? 0) ? "failed" : "ok" }, batch.length);
          const part = await d.store.blobs.put(src.vaultId, JSON.stringify(batch.map((p, i) => [p, r.pages[i] ?? ""])));
          return c.next("ocr", { ...rest, ocr: { ...st, done: st.done + batch.length, parts: [...st.parts, part.sha256], model: r.model || st.model, waits: 0, failed } });
        }
        const text = new Map<number, string>();
        for (const sha of st.parts) {
          for (const [p, t] of JSON.parse((await d.store.readBlob(src.vaultId, sha)).toString("utf8")) as [number, string][]) text.set(p, t.trim());
        }
        const before = src.extractedSha ? (await d.store.readBlob(src.vaultId, src.extractedSha)).toString("utf8") : "";
        const pdf = src.mime === "application/pdf";
        const found = [...text.values()].some(Boolean);
        const merged = mergeOcr(before, text, pdf) || (pdf ? before : `Immagine "${src.name}" senza testo riconoscibile.`);
        const blob = await d.store.blobs.put(src.vaultId, merged);
        const warnings = ((src.meta.warnings as string[] | undefined) ?? []).filter((w) => w !== "needs_ocr" && w !== "ocr_unavailable");
        if (st.truncated) warnings.push("ocr_truncated");
        if (st.failed) warnings.push("ocr_failed");
        if (!found) warnings.push("no_text");
        await d.store.update(src.id, { extracted_sha: blob.sha256, text_tokens: Math.ceil(merged.length / 3.6) }, { warnings, ocr: { model: st.model ?? null, pages: st.pages.length, failed: st.failed ?? 0 } });
        await d.store.log(src.vaultId, "ingest", `${src.name}: OCR di ${st.pages.length} pagine`, src.id, undefined, src.classification);
        return c.next("index", { ...rest, lang: found ? detectLang(merged) : (rest.lang ?? "simple") });
      },

      index: async (c) => {
        const src = await d.store.get(c.task.input.sourceId);
        if (!src) return c.fail("source deleted");
        const md = (await d.store.readBlob(src.vaultId, src.extractedSha!)).toString("utf8");
        const n = await d.store.writeChunks(src, md, c.task.state.lang ?? "italian", d.chunk);
        await d.store.update(src.id, { status: "indexed", level: 1 });
        await d.store.log(src.vaultId, "ingest", src.title ?? src.name, src.id, { chunks: n, origin: src.origin }, src.classification);
        return c.next("embed", c.task.state);
      },

      embed: async (c) => {
        const src = await d.store.get(c.task.input.sourceId);
        if (!src) return c.fail("source deleted");
        const indexer = d.indexer();
        if (indexer) {
          await indexer.run(src.vaultId, Number.MAX_SAFE_INTEGER, c.signal, src.id);
          await d.store.update(src.id, { status: "embedded", level: 2 });
        }
        if (src.compile && src.compiledPage && src.extractedSha && src.meta?.compiledSha === src.extractedSha) {
          // M20: the text the model compiled, read again the same way (a reingest, a new parser
          // version): same chunks, so the pages and their citations already say what it says
          await d.store.update(src.id, { level: 3, status: "compiled" });
          await d.store.log(src.vaultId, "compile", src.title ?? src.name, src.id, { pages: 0, model: false, unchanged: true }, src.classification);
          metrics.inc("compile_unchanged");
          log.info("compile skipped: text unchanged", { source: src.id });
          return c.done({ level: 3, status: "compiled" });
        }
        return src.compile ? c.next("compile", c.task.state) : c.done({ level: indexer ? 2 : 1, status: indexer ? "embedded" : "indexed" });
      },

      compile: async (c) => {
        const src = (await d.store.get(c.task.input.sourceId)) as Source | undefined;
        if (!src) return c.fail("source deleted");
        if (d.chatBusy?.()) {
          const waits = c.task.state.compileWaits ?? 0;
          const pause = (d.compileRetryMs ?? 15_000) * 2 ** Math.min(waits, 3);
          return c.sleepUntil(new Date(Date.now() + pause), "compile", { ...c.task.state, compileWaits: waits + 1 });
        }
        // idle compiles (task priority 3 and more) give the model the background priority
        const r = await d.compiler.compile(src, { signal: c.signal, ...(c.task.priority >= 3 ? { priority: 2 as const } : {}) });
        log.info("source compiled", { source: src.id, pages: r.pages.length, model: r.usedModel });
        return c.done({ level: 3, status: "compiled" });
      },
    },
  });
  return task;
}
