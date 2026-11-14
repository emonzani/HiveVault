/**
 * Spike D — embeddings on CPU, local and "remote" endpoints (plan §2.4, D7/D10).
 *
 * Uses a real llama-server on the CPU (--device none) through the real supervisor and
 * dispatcher, with the corpus documents as input:
 *  1. throughput (tokens/s, chunks/s) and process memory for several thread limits;
 *  2. local + second endpoint together (work pulling), and the split between them;
 *  3. latency of interactive queries (priority 0) while a backfill (priority 2) runs;
 *  4. identity check: an endpoint with a different model is refused;
 *  5. retrieval sanity on the corpus questions (hit@5 of the expected source document).
 *
 * The planned models (Qwen3-Embedding-0.6B, bge-m3) are not on this machine yet: the run
 * uses the model given with --model (default: nomic-embed-text-v1.5 from LM Studio) as a
 * stand-in for speed and memory. Retrieval quality must be measured again with the real model.
 *
 * Usage: npm run spike:d -- --bin <llama-server> --model <file.gguf> [--threads 4,8,12] [--corpus data/corpus/dev]
 */
import "../../packages/db/src/env.ts";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LlamaEndpoint, LocalModelSupervisor, ModelDispatcher, mockEmbedding, normalizeModelName } from "@cb/models";

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const required = (name: string, env: string) => {
  const v = opt(name, process.env[env] ?? "");
  if (!v) {
    console.error(`Missing --${name} (or ${env}). Usage: tsx bench/spike-d/run.ts --bin <llama-server> --model <embedding .gguf>`);
    process.exit(2);
  }
  return v;
};
const BIN = required("bin", "LOCAL_LLAMA_BIN");
const MODEL = required("model", "SPIKE_MODEL");
const THREADS = opt("threads", "4,8,12").split(",").map(Number);
const CORPUS = path.resolve(opt("corpus", "data/corpus/dev"));
const POOLING = opt("pooling", "mean");
const DOC_PREFIX = opt("doc-prefix", "search_document: ");
const QUERY_PREFIX = opt("query-prefix", "search_query: ");
const BATCH = Number(opt("batch", "64"));
const modelName = normalizeModelName(MODEL);

const out: string[] = [];
const log = (s = "") => {
  console.log(s);
  out.push(s);
};

// ---------------------------------------------------------------------------
// Corpus -> chunks (~1200 characters on paragraph boundaries)
// ---------------------------------------------------------------------------
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])));
  return files.flat();
}
interface Chunk {
  doc: string;
  text: string;
}
const docsDir = path.join(CORPUS, "docs");
const chunks: Chunk[] = [];
for (const file of (await walk(docsDir)).sort()) {
  const rel = path.relative(docsDir, file).replaceAll("\\", "/");
  const body = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
  let cur = "";
  for (const para of body.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > 1200) {
      chunks.push({ doc: rel, text: cur });
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + para;
  }
  if (cur.trim()) chunks.push({ doc: rel, text: cur });
}
const questions = (await readFile(path.join(CORPUS, "truth", "questions.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { question: string; sources: string[]; kind: string });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rssMb(pid: number | undefined): number | undefined {
  if (!pid) return undefined;
  try {
    if (process.platform === "win32") {
      const csv = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      const kb = Number(/"([\d.,]+) K"/.exec(csv)?.[1]?.replace(/[.,]/g, ""));
      return Number.isFinite(kb) ? kb / 1024 : undefined;
    }
    const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return kb / 1024;
  } catch {
    return undefined;
  }
}

function supervisor(name: string, port: number, threads: number) {
  return new LocalModelSupervisor({
    name,
    kind: "embed",
    bin: BIN,
    model: MODEL,
    port,
    threads,
    pooling: POOLING,
    parallel: 4,
    context: 8192,
    extraArgs: ["--device", "none"],
    healthIntervalMs: 500,
    startTimeoutMs: 120_000,
  });
}

function batches<T>(xs: T[], n: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < xs.length; i += n) r.push(xs.slice(i, i + n));
  return r;
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

async function embedAll(d: ModelDispatcher, texts: string[]): Promise<{ vectors: number[][]; tokens: number; seconds: number }> {
  const t0 = performance.now();
  const parts = await Promise.all(batches(texts, BATCH).map((b) => d.embed(b, { priority: 2 })));
  return {
    vectors: parts.flatMap((p) => p.vectors),
    tokens: parts.reduce((s, p) => s + p.tokens, 0),
    seconds: (performance.now() - t0) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const cpu = os.cpus();
log(`# Spike D — embeddings on CPU, local and remote endpoints\n`);
log(`${new Date().toISOString()} · ${cpu[0]?.model.trim()} (${cpu.length} logical CPUs) · ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB RAM`);
log(`Model: \`${path.basename(MODEL)}\` (stand-in; planned: Qwen3-Embedding-0.6B-Q8_0) · llama-server on CPU (\`--device none\`, -np 4, -c 8192, pooling ${POOLING})`);
log(`Input: ${chunks.length} chunks (≤ 1200 characters) from ${new Set(chunks.map((c) => c.doc)).size} corpus documents, batches of ${BATCH}\n`);

const docTexts = chunks.map((c) => DOC_PREFIX + c.text);
let lastVectors: number[][] = [];
let dims = 0;

log(`## 1. Throughput and memory by thread limit (local endpoint)\n`);
log(`| Threads | Tokens/s | Chunks/s | Time | Process memory |`);
log(`|---|---|---|---|---|`);
for (const t of THREADS) {
  const sup = supervisor(`spike-d-${t}`, 18101, t);
  await sup.ensureRunning();
  const d = new ModelDispatcher({ expected: { embed: { model: modelName, dimensions: 256 } } });
  await d.addEndpoint(new LlamaEndpoint({ id: "local", kind: "embed", origin: "local", url: sup.url, slots: 4, timeoutMs: 600_000 }));
  await d.embed(["riscaldamento"], { priority: 0 }); // warm-up
  const r = await embedAll(d, docTexts);
  const mem = rssMb(sup.snapshot().pid);
  log(`| ${t} | ${(r.tokens / r.seconds).toFixed(0)} | ${(chunks.length / r.seconds).toFixed(1)} | ${r.seconds.toFixed(1)} s | ${mem ? `${mem.toFixed(0)} MB` : "n/d"} |`);
  if (t === THREADS.at(-1)) {
    lastVectors = r.vectors;
  }
  const id = await new LlamaEndpoint({ id: "probe", kind: "embed", origin: "local", url: sup.url }).identity();
  dims = id.dimensions ?? 0;
  d.stop();
  await sup.stop();
}

log(`\n## 2. Local + second endpoint together\n`);
const half = Math.max(2, Math.floor(THREADS.at(-1)! / 2));
const supA = supervisor("spike-d-local", 18101, half);
const supB = supervisor("spike-d-remote", 18102, half);
await Promise.all([supA.ensureRunning(), supB.ensureRunning()]);
const d2 = new ModelDispatcher({ expected: { embed: { model: modelName, dimensions: 256 } } });
await d2.addEndpoint(new LlamaEndpoint({ id: "local", kind: "embed", origin: "local", url: supA.url, slots: 4, timeoutMs: 600_000 }));
await d2.addEndpoint(new LlamaEndpoint({ id: "remote-1", kind: "embed", origin: "remote", url: supB.url, slots: 4, timeoutMs: 600_000 }));
await Promise.all([d2.embed(["a"], { priority: 2 }), d2.embed(["b"], { priority: 2 })]);

// backfill at priority 2 and, at the same time, interactive queries at priority 0
const tStart = performance.now();
let backfillEnd = 0;
const backfill = embedAll(d2, docTexts).then((r) => ((backfillEnd = performance.now() - tStart), r));
const latencies: number[] = [];
const during: string[] = [];
for (let i = 0; i < 20; i++) {
  const q = QUERY_PREFIX + questions[i % questions.length]!.question;
  const t = performance.now();
  await d2.embed([q], { priority: 0 });
  latencies.push(performance.now() - t);
  during.push(`${((t - tStart) / 1000).toFixed(1)}s→${(performance.now() - t).toFixed(0)}ms${backfillEnd ? "" : "*"}`);
  await new Promise((r) => setTimeout(r, 150));
}
const rb = await backfill;

const snap = d2.snapshot().endpoints;
log(`Two llama-server processes with ${half} threads each, on the same machine (the CPU is shared: a real remote host adds its own CPU).\n`);
log(`- Combined throughput: ${(rb.tokens / rb.seconds).toFixed(0)} tokens/s, ${(chunks.length / rb.seconds).toFixed(1)} chunks/s`);
log(`- Split of the work (items): ${snap.map((e) => `${e.id} ${e.items}`).join(" · ")}`);
log(`- Interactive query (priority 0) during the backfill: p50 ${pct(latencies, 0.5).toFixed(0)} ms · p95 ${pct(latencies, 0.95).toFixed(0)} ms · max ${Math.max(...latencies).toFixed(0)} ms`);
log(`- Query timeline (start → latency, * = backfill still running; backfill ended at ${(backfillEnd / 1000).toFixed(1)} s): ${during.join(" ")}`);
log(`- Dispatcher rules: 1 slot per endpoint reserved for interactive jobs; background batches split into requests of 2 texts (callers pass batches of ${BATCH}).`);
d2.stop();

log(`\n## 3. Identity check\n`);
const d3 = new ModelDispatcher({ expected: { embed: { model: "Qwen3-Embedding-0.6B-Q8_0.gguf", dimensions: 1024 } } });
const st = await d3.addEndpoint(new LlamaEndpoint({ id: "wrong-model", kind: "embed", origin: "remote", url: supB.url }));
log(`- Endpoint with \`${modelName}\` while EMBED_MODEL_ID is Qwen3-Embedding-0.6B: status **${st}** — ${d3.snapshot().endpoints[0]?.reason}`);
d3.stop();
await Promise.all([supA.stop(), supB.stop()]);

log(`\n## 4. Retrieval sanity on the corpus questions\n`);
// Real model vectors from step 1 vs the deterministic mock (lexical hashing) as a baseline.
const supQ = supervisor("spike-d-q", 18101, THREADS.at(-1)!);
await supQ.ensureRunning();
const dq = new ModelDispatcher({ expected: { embed: { model: modelName, dimensions: 256 } } });
await dq.addEndpoint(new LlamaEndpoint({ id: "local", kind: "embed", origin: "local", url: supQ.url, slots: 4 }));
const qv = (await Promise.all(batches(questions.map((q) => QUERY_PREFIX + q.question), BATCH).map((b) => dq.embed(b, { priority: 1 })))).flatMap((r) => r.vectors);
dq.stop();
await supQ.stop();

const dot = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
function hitAt5(qvecs: number[][], dvecs: number[][]) {
  const byKind: Record<string, [number, number]> = {};
  let hits = 0;
  questions.forEach((q, i) => {
    const scored = dvecs.map((v, j) => [dot(qvecs[i]!, v), j] as const).sort((a, b) => b[0] - a[0]);
    const docs: string[] = [];
    for (const [, j] of scored) {
      const doc = chunks[j]!.doc;
      if (!docs.includes(doc)) docs.push(doc);
      if (docs.length === 5) break;
    }
    const hit = q.sources.some((s) => docs.includes(s));
    hits += hit ? 1 : 0;
    const k = (byKind[q.kind] ??= [0, 0]);
    k[0] += hit ? 1 : 0;
    k[1]++;
  });
  return { total: hits / questions.length, byKind };
}
const real = hitAt5(qv, lastVectors);
const mockD = chunks.map((c) => mockEmbedding(c.text, 1024));
const mockQ = questions.map((q) => mockEmbedding(q.question, 1024));
const mock = hitAt5(mockQ, mockD);
log(`hit@5 = the expected source document is among the first 5 documents (${questions.length} questions, ${chunks.length} chunks, ${dims} dimensions).\n`);
log(`| Question kind | ${path.basename(MODEL, ".gguf")} | Mock (lexical hashing) |`);
log(`|---|---|---|`);
for (const k of Object.keys(real.byKind)) {
  const [a, n] = real.byKind[k]!;
  const [b] = mock.byKind[k]!;
  log(`| ${k} (${n}) | ${((a / n) * 100).toFixed(0)}% | ${((b / n) * 100).toFixed(0)}% |`);
}
log(`| **total** | **${(real.total * 100).toFixed(0)}%** | **${(mock.total * 100).toFixed(0)}%** |`);
log(`\nNote: "updated" questions expect the newest source; vector search alone cannot know which value is current — that is the job of the compiled page (stato attuale + timeline).`);

await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
await writeFile(path.resolve(here, "../../docs/spikes/spike-d.md"), out.join("\n") + "\n");
process.exit(0);
