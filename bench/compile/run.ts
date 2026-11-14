/**
 * Compilation benchmark (M13): how long and how many model tokens the I3 compilation of one
 * source costs with the configured chat model, and how much of the synthetic corpus truth
 * ends up in the compiled pages.
 *
 * 1. The documents of the first questions of the corpus go into a new vault through the real
 *    pipeline, without compilation, up to I2.
 * 2. Every source is compiled by the real `Compiler`, one after the other (the chat endpoint
 *    has parallelism 1): wall time, agent turns, prompt and completion tokens, pages written,
 *    writes refused by `Compiler.validate`.
 * 3. Every question whose sources were all compiled is searched among the model-written pages
 *    only (no source pages, no chunks): is the expected answer in the top 5 pages?
 *
 * Usage: npx tsx bench/compile/run.ts [--corpus data/corpus/dev] [--docs 20] [--mode extract|agent] [--keep] [--mock]
 * Needs the chat model (LLAMA_SERVER_URL) and an embedding model. `--mock` runs with the mock
 * chat model when no real one answers, to check the harness: its numbers mean nothing and no
 * report goes to docs/.
 * Stop the development server first: the benchmark starts its own workers.
 */
import "../../packages/db/src/env.ts"; // .env first: the model settings are read when the services start
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeTitle, readPage, type Principal } from "@cb/brain";
import { loadServerConfig } from "../../packages/server/src/config.ts";
import { createServices } from "../../packages/server/src/services.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const CORPUS = opt("corpus", "data/corpus/dev");
const DOCS = Number(opt("docs", "20"));
const KEEP = args.includes("--keep");
/** Allowed to run without a real chat model; a real model, when up, is always used. */
const ALLOW_MOCK = args.includes("--mock");
const MODE = opt("mode", process.env.COMPILE_MODE || "extract");
process.env.COMPILE_MODE = MODE;
// the backlog of the database must not share the model with the measured compilations (M3)
process.env.IDLE_COMPILE = "false";

interface Question {
  id: string;
  question: string;
  answer: string;
  sources: string[];
  kind: string;
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s]`, ...a);
const questions = (await readFile(path.join(CORPUS, "truth/questions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Question);

// the documents of the first questions: the quality check needs questions with every source compiled
const picked: string[] = [];
for (const q of questions) {
  const add = q.sources.filter((s) => !picked.includes(s));
  if (picked.length + add.length > DOCS) continue;
  picked.push(...add);
  if (picked.length >= DOCS) break;
}

const s = await createServices(loadServerConfig(), { models: true, workers: true });
const sql = s.sql;

// wait for an embedding model, and for the chat model unless --mock
for (let i = 0; i < 120; i++) {
  const eps = s.models.dispatcher.snapshot().endpoints;
  if (eps.some((e) => e.kind === "embed" && e.status === "up" && e.origin !== "mock") && (ALLOW_MOCK || s.compiler.modelAvailable())) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const eps = s.models.dispatcher.snapshot().endpoints;
log("modelli:", eps.map((e) => `${e.id}=${e.status}`).join(" "));
const MOCK = !s.compiler.modelAvailable();
if (MOCK && !ALLOW_MOCK) {
  log("nessun modello di chat raggiungibile: avvia l'host del modello o usa --mock per provare il benchmark");
  await s.stop();
  process.exit(2);
}
const chatModel = MOCK ? "mock" : (process.env.LLAMA_MODEL_ID ?? "?").split(/[\\/]/).pop()!;

// ---------------------------------------------------------------------------
// 1. Ingestion up to I2
// ---------------------------------------------------------------------------
const run = Date.now().toString(36);
for (const v of await sql<{ id: string }[]>`select id from vaults where slug like 'cbench-%'`) await s.vaults.delete(v.id);
const vault = await s.vaults.create({ kind: "cell", slug: `cbench-${run}`, name: `Compile bench ${run}`, defaultClassification: 1 });
const sourceOfPath = new Map<string, string>();
for (const rel of picked) {
  const r = await s.ingest.upload(vault.id, await readFile(path.join(CORPUS, "docs", rel)), rel, null, { compile: false });
  sourceOfPath.set(rel, r.source.id);
}
log(`caricati ${picked.length} documenti nel vault ${vault.slug}`);
for (const start = Date.now(); ; ) {
  const [r] = await sql<{ done: number; total: number }[]>`
    select count(*) filter (where level >= 2 or status in ('failed', 'unsupported'))::int as done, count(*)::int as total
    from sources where vault_id = ${vault.id} and parent_id is null`;
  if (r!.done >= r!.total) {
    log(`I2 completo in ${((Date.now() - start) / 1000).toFixed(0)} s`);
    break;
  }
  await new Promise((res) => setTimeout(res, 2000));
}

// ---------------------------------------------------------------------------
// 2. Compilation, one source at a time
// ---------------------------------------------------------------------------
interface Row {
  path: string;
  textTokens: number;
  ms: number;
  turns: number;
  prompt: number;
  completion: number;
  pages: number;
  refused: number;
  error?: string;
}
const rows: Row[] = [];
for (const rel of picked) {
  const src = await s.ingest.store.get(sourceOfPath.get(rel)!);
  if (!src || src.level < 2) {
    rows.push({ path: rel, textTokens: 0, ms: 0, turns: 0, prompt: 0, completion: 0, pages: 0, refused: 0, error: src?.status ?? "missing" });
    continue;
  }
  const st = Date.now();
  try {
    const r = await s.compiler.compile(src, { useModel: true });
    rows.push({ path: rel, textTokens: src.textTokens ?? 0, ms: Date.now() - st, turns: r.turns, prompt: r.tokens.prompt, completion: r.tokens.completion, pages: r.pages.length, refused: r.refusedWrites });
  } catch (e) {
    rows.push({ path: rel, textTokens: src.textTokens ?? 0, ms: Date.now() - st, turns: 0, prompt: 0, completion: 0, pages: 0, refused: 0, error: String((e as Error).message ?? e).slice(0, 200) });
  }
  const x = rows.at(-1)!;
  log(`${rows.length}/${picked.length} ${rel}: ${(x.ms / 1000).toFixed(0)} s, ${x.turns} turni, ${x.prompt}+${x.completion} token, ${x.pages} pagine${x.error ? `, errore: ${x.error}` : ""}`);
}

// ---------------------------------------------------------------------------
// 3. Truth in the model-written pages
// ---------------------------------------------------------------------------
const principal: Principal = { id: "bench:compile", vaults: [vault.id], clearance: 3 };
const norm = (x: string) => normalizeTitle(x).replace(/\s+/g, " ");
const variants = (a: string) => {
  const v = new Set([norm(a)]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  if (iso) v.add(norm(`${iso[3]}/${iso[2]}/${iso[1]}`));
  const it = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(a);
  if (it) v.add(norm(`${it[3]}-${it[2]}-${it[1]}`));
  return [...v];
};
const parts = (answer: string) => (answer.includes(";") ? answer.split(";") : [answer.split(":")[0]!]).map((x) => x.trim()).filter(Boolean);
const found = (text: string, answer: string) => {
  const ps = parts(answer);
  const hit = ps.filter((p) => variants(p).some((v) => norm(text).includes(v))).length / ps.length;
  return hit >= (answer.includes(";") ? 0.8 : 1);
};
const compiledOk = new Set(rows.filter((r) => !r.error).map((r) => r.path));
const checked = questions.filter((q) => q.sources.every((x) => compiledOk.has(x)));
let inPages = 0;
const missed: { id: string; question: string; answer: string; kind: string; top: string[] }[] = [];
const byKind = new Map<string, { n: number; ok: number }>();
for (const q of checked) {
  const r = await s.search.search(principal, q.question, { includeSources: false, limit: 5, maxTokens: 4000 });
  let text = "";
  for (const h of r.hits) text += (await readPage(sql, principal, h.id, { maxTokens: 2500 }))?.content ?? "";
  const ok = found(text, q.answer);
  if (ok) inPages++;
  else missed.push({ id: q.id, question: q.question, answer: q.answer, kind: q.kind, top: r.hits.map((h) => h.title) });
  const k = byKind.get(q.kind) ?? { n: 0, ok: 0 };
  byKind.set(q.kind, { n: k.n + 1, ok: k.ok + (ok ? 1 : 0) });
}
const [{ pages }] = (await sql`select count(*)::int as pages from pages where vault_id = ${vault.id} and type <> 'source'`) as unknown as [{ pages: number }];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const ok = rows.filter((r) => !r.error);
const sum = (f: (r: Row) => number) => ok.reduce((a, r) => a + f(r), 0);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const avg = (f: (r: Row) => number) => (ok.length ? sum(f) / ok.length : 0);
const secPerDoc = avg((r) => r.ms) / 1000;
const summary = {
  date: new Date().toISOString(),
  model: chatModel,
  mode: MODE,
  mock: MOCK,
  documents: picked.length,
  compiled: ok.length,
  failed: rows.length - ok.length,
  secondsPerDoc: { avg: secPerDoc, p50: pct(ok.map((r) => r.ms), 0.5) / 1000, p90: pct(ok.map((r) => r.ms), 0.9) / 1000 },
  turnsPerDoc: avg((r) => r.turns),
  tokensPerDoc: { prompt: avg((r) => r.prompt), completion: avg((r) => r.completion), sourceText: avg((r) => r.textTokens) },
  completionTokensPerSecond: sum((r) => r.ms) ? sum((r) => r.completion) / (sum((r) => r.ms) / 1000) : 0,
  pagesPerDoc: avg((r) => r.pages),
  refusedPerDoc: avg((r) => r.refused),
  docsPerHour: secPerDoc ? 3600 / secPerDoc : 0,
  hoursFor1000Docs: (secPerDoc * 1000) / 3600,
  modelPages: pages,
  truth: { questions: checked.length, inCompiledPages: inPages, byKind: Object.fromEntries(byKind), missed },
  rows,
};
await mkdir("bench/out", { recursive: true });
await writeFile(`bench/out/compile-${run}.json`, JSON.stringify(summary, null, 2));
const f = (n: number, d = 0) => n.toLocaleString("it-IT", { maximumFractionDigits: d, minimumFractionDigits: d });
const md = [
  `# Benchmark della compilazione (M13)`,
  "",
  `${summary.date} · modello \`${chatModel}\` · modalità \`${MODE}\` · ${picked.length} documenti del corpus \`${CORPUS}\` · compilazione una sorgente alla volta`,
  "",
  `| Misura | Valore |`,
  `|---|---|`,
  `| Sorgenti compilate / fallite | ${ok.length} / ${rows.length - ok.length} |`,
  `| Secondi per sorgente (media, p50, p90) | ${f(secPerDoc)} · ${f(summary.secondsPerDoc.p50)} · ${f(summary.secondsPerDoc.p90)} |`,
  `| Turni dell'agente per sorgente | ${f(summary.turnsPerDoc, 1)} |`,
  `| Token per sorgente (prompt, risposta) | ${f(summary.tokensPerDoc.prompt)} · ${f(summary.tokensPerDoc.completion)} |`,
  `| Token di testo della sorgente (media) | ${f(summary.tokensPerDoc.sourceText)} |`,
  `| Token di risposta al secondo | ${f(summary.completionTokensPerSecond, 1)} |`,
  `| Pagine scritte per sorgente · scritture rifiutate | ${f(summary.pagesPerDoc, 1)} · ${f(summary.refusedPerDoc, 1)} |`,
  `| Sorgenti all'ora | ${f(summary.docsPerHour, 1)} |`,
  `| Ore per 1.000 sorgenti | ${f(summary.hoursFor1000Docs, 1)} |`,
  `| Risposte attese nelle pagine del modello (top 5) | ${inPages}/${checked.length} |`,
  ...[...byKind].map(([k, v]) => `| … domande «${k}» | ${v.ok}/${v.n} |`),
  "",
  `Dati per sorgente: \`bench/out/compile-${run}.json\`.`,
  "",
].join("\n");
if (!MOCK) await writeFile(`docs/spikes/compile-bench${MODE === "agent" ? "" : `-${MODE}`}.md`, md);
console.log(`\n${md}`);
if (MOCK) log("--mock: i numeri verificano solo il benchmark, nessun rapporto in docs/spikes");

if (!KEEP) await s.vaults.delete(vault.id);
await s.stop();
process.exit(0);
