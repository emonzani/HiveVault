/**
 * Retrieval eval of phase 6 (plan §10): the synthetic corpus knows its facts, so the expected
 * answer and the expected source documents of every question are known.
 *
 * 1. The corpus documents go into a new vault through the real pipeline (local parsers, local
 *    embedding model): I2. Ten "canary" documents are loaded as "riservato".
 * 2. Every question goes to `brain_search` (the MCP tool, top 5 with reranker) for an API
 *    account with clearance interno: recall@5 on the expected sources, hit@1, MRR, tokens.
 *    Cross questions ("incrocio": two facts in two documents) also count "all@5": every
 *    expected source in the top 5, the condition for an answer without a second search.
 * 3. A sample goes to `brain_ask` (local chat model): correct answers, citation precision
 *    (cited passages that contain the expected answer), contradictions noticed.
 * 4. No canary may come back, by search or by id.
 *
 * Usage: npx tsx bench/phase6/eval.ts [--corpus data/corpus/dev] [--ask 30] [--keep]
 * Needs the local embedding and reranker models (LOCAL_MODELS_ENABLED) and, for --ask, the
 * chat model. Stop the development server first: the eval starts its own model processes.
 */
import "../../packages/db/src/env.ts"; // .env first: the model settings are read when the services start
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "@cb/shared";
import { brainAskRaw, brainRead, brainSearch, brainSearchRaw, MCP_MAX_CLASSIFICATION, ToolError, type ToolContext } from "@cb/mcp";
import { normalizeTitle } from "@cb/brain";
import { loadServerConfig } from "../../packages/server/src/config.ts";
import { createServices } from "../../packages/server/src/services.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const CORPUS = opt("corpus", "data/corpus/dev");
const ASK = Number(opt("ask", "30"));
const KEEP = args.includes("--keep");

interface Question {
  id: string;
  question: string;
  answer: string;
  factIds: string[];
  sources: string[];
  kind: string;
}
interface Contradiction {
  doc: string;
  factId: string;
  statedValue: string;
  trueValue: string;
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a);
const manifest = JSON.parse(await readFile(path.join(CORPUS, "manifest.json"), "utf8")) as { seed: number; documents: number };
const questions = (await readFile(path.join(CORPUS, "truth/questions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Question);
const contradictions = (await readFile(path.join(CORPUS, "truth/contradictions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Contradiction);

const s = await createServices(loadServerConfig(), { models: true, workers: true });
const sql = s.sql;

// wait for the local models
for (let i = 0; i < 120; i++) {
  const eps = s.models.dispatcher.snapshot().endpoints;
  if (eps.some((e) => e.id === "local-embed" && e.status === "up") && eps.some((e) => e.id === "local-rerank" && e.status === "up")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const eps = s.models.dispatcher.snapshot().endpoints;
const chatUp = eps.some((e) => e.id === "chat" && e.status === "up");
log("modelli:", eps.map((e) => `${e.id}=${e.status}`).join(" "));

// ---------------------------------------------------------------------------
// 1. Ingestion
// ---------------------------------------------------------------------------
const run = Date.now().toString(36);
// vaults left by an interrupted run
for (const v of await sql<{ id: string }[]>`select id from vaults where slug like 'eval-%'`) await s.vaults.delete(v.id);
await sql`update tasks set status = 'cancelled', finished_at = now() where name = 'ingest' and status in ('queued', 'sleeping') and input->>'sourceId' not in (select id from sources)`;
const vault = await s.vaults.create({ kind: "space", slug: `eval-${run}`, name: `Eval ${run}`, defaultClassification: 1 });
const files: string[] = [];
async function walk(dir: string) {
  for (const e of await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else files.push(p);
  }
}
await walk(path.join(CORPUS, "docs"));
const relOf = (p: string) => path.relative(path.join(CORPUS, "docs"), p).replace(/\\/g, "/");
const pathOfSource = new Map<string, string>();
for (const f of files) {
  const r = await s.ingest.upload(vault.id, await readFile(f), relOf(f), null, { compile: false });
  pathOfSource.set(r.source.id, relOf(f));
}
const canaries: string[] = [];
for (let i = 1; i <= 10; i++) {
  const text = `# Nota riservata ${i}\n\nCanarino ${run}-${i}: il budget riservato del piano di acquisizione Orione è di ${i} milioni. Questa informazione non deve uscire.\n`;
  const r = await s.ingest.upload(vault.id, Buffer.from(text), `riservato/canarino-${i}.md`, null, { compile: false, classification: 2 });
  canaries.push(r.source.id);
}
log(`caricati ${files.length} documenti + ${canaries.length} canarini riservati nel vault ${vault.slug}`);

const ingestStart = Date.now();
for (;;) {
  const [r] = await sql<{ done: number; total: number; failed: number }[]>`
    select count(*) filter (where level >= 2 or status in ('failed', 'unsupported'))::int as done, count(*)::int as total,
           count(*) filter (where status in ('failed', 'unsupported'))::int as failed
    from sources where vault_id = ${vault.id} and parent_id is null`;
  if (r!.done >= r!.total) {
    log(`indicizzazione I2 completa: ${r!.total} documenti, ${r!.failed} non leggibili, ${((Date.now() - ingestStart) / 1000).toFixed(0)} s`);
    break;
  }
  if ((Date.now() - ingestStart) % 30_000 < 2000) log(`… ${r!.done}/${r!.total}`);
  await new Promise((res) => setTimeout(res, 2000));
}
const [{ chunks, tokens }] = (await sql`select count(*)::int as chunks, coalesce(sum(tokens), 0)::int as tokens from chunks where vault_id = ${vault.id}`) as unknown as [{ chunks: number; tokens: number }];

// ---------------------------------------------------------------------------
// 2. Search
// ---------------------------------------------------------------------------
const ctx: ToolContext = {
  sql,
  search: s.search,
  pages: s.pages,
  dispatcher: s.models.dispatcher,
  account: { id: `eval-${run}`, name: "eval", scopes: ["read"], clearance: 3 },
  vaults: new Map([[vault.id, "read"]]),
};
interface Row {
  q: Question;
  rank: number | null;
  /** Every expected source is in the top 5. */
  all5: boolean;
  top: string[];
  tokens: number;
  ms: number;
  maxClass: number;
}
const rows: Row[] = [];
for (const q of questions) {
  const st = Date.now();
  const r = await brainSearchRaw(ctx, { query: q.question, limit: 5, max_tokens: 2000 });
  const text = await brainSearch(ctx, { query: q.question, limit: 5, max_tokens: 2000 });
  const top = r.hits.map((h) => (h.kind === "source" ? (pathOfSource.get(h.id) ?? h.id) : h.id));
  const idx = top.findIndex((p) => q.sources.includes(p));
  rows.push({ q, rank: idx >= 0 ? idx + 1 : null, all5: q.sources.every((x) => top.includes(x)), top, tokens: estimateTokens(text), ms: Date.now() - st, maxClass: Math.max(-1, ...r.hits.map((h) => h.classification)) });
}
const recall5 = rows.filter((r) => r.rank !== null).length / rows.length;
const hit1 = rows.filter((r) => r.rank === 1).length / rows.length;
const mrr = rows.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / rows.length;
const avgTok = rows.reduce((a, r) => a + r.tokens, 0) / rows.length;
const p50 = [...rows].sort((a, b) => a.ms - b.ms)[Math.floor(rows.length / 2)]!.ms;
const byKind = new Map<string, Row[]>();
for (const r of rows) byKind.set(r.q.kind, [...(byKind.get(r.q.kind) ?? []), r]);
log(`recall@5 ${recall5.toFixed(3)} · hit@1 ${hit1.toFixed(3)} · MRR ${mrr.toFixed(3)} · ${avgTok.toFixed(0)} token per risposta · p50 ${p50} ms`);

// ---------------------------------------------------------------------------
// 3. Canaries: never above "interno"
// ---------------------------------------------------------------------------
let canaryLeaks = 0;
const canarySearch = await brainSearchRaw(ctx, { query: `budget riservato acquisizione Orione canarino ${run}`, limit: 20, max_tokens: 8000 });
canaryLeaks += canarySearch.hits.filter((h) => canaries.includes(h.id) || h.classification > MCP_MAX_CLASSIFICATION).length;
for (const id of canaries) {
  try {
    await brainRead(ctx, { id });
    canaryLeaks++;
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
  }
}
const aboveInterno = rows.filter((r) => r.maxClass > MCP_MAX_CLASSIFICATION).length;
log(`canarini riservati restituiti: ${canaryLeaks}; risposte con pagine sopra «interno»: ${aboveInterno}`);

// ---------------------------------------------------------------------------
// 4. brain_ask on a sample (local chat model)
// ---------------------------------------------------------------------------
const norm = (x: string) => normalizeTitle(x).replace(/\s+/g, " ");
const variants = (a: string) => {
  const v = new Set([norm(a)]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  if (iso) v.add(norm(`${iso[3]}/${iso[2]}/${iso[1]}`));
  const it = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(a);
  if (it) v.add(norm(`${it[3]}-${it[2]}-${it[1]}`));
  return [...v];
};
const contains = (text: string, answer: string) => variants(answer).some((v) => norm(text).includes(v));
/**
 * Key parts of an expected answer: "SQL Server: vincolo …" → the value before the colon;
 * "Progetto A; Progetto B" → every item. An answer is correct when it contains the value, or
 * at least 80% of the items of a list.
 */
const parts = (answer: string) => (answer.includes(";") ? answer.split(";") : [answer.split(":")[0]!]).map((x) => x.trim()).filter(Boolean);
const coverage = (text: string, answer: string) => {
  const ps = parts(answer);
  return ps.filter((p) => contains(text, p)).length / ps.length;
};
const answered = (text: string, answer: string) => coverage(text, answer) >= (answer.includes(";") ? 0.8 : 1);
const supports = (text: string, answer: string) => parts(answer).some((p) => contains(text, p));
interface AskRow {
  q: Question;
  correct: boolean;
  cites: number;
  goodCites: number;
  unknown: number;
  tokens: number;
  ms: number;
  answer: string;
  contradiction?: { noticed: boolean; both: boolean };
}
const askRows: AskRow[] = [];
if (chatUp && ASK > 0) {
  // every contradiction question, up to 10 cross questions, then a spread of the others
  const cq = new Set(contradictions.map((c) => c.factId));
  const contraQs = [...questions.filter((q) => q.factIds.some((f) => cq.has(f))), ...questions.filter((q) => q.kind === "incrocio").slice(0, 10)];
  const others = questions.filter((q) => !contraQs.includes(q));
  const step = Math.max(1, Math.floor(others.length / Math.max(1, ASK - contraQs.length)));
  const sample = [...contraQs, ...others.filter((_, i) => i % step === 0)].slice(0, ASK);
  for (const q of sample) {
    const st = Date.now();
    let r;
    try {
      r = await brainAskRaw(ctx, { question: q.question, max_tokens: 3000 });
    } catch (e) {
      log(`ask ${q.id}: ${(e as Error).message}`);
      continue;
    }
    let good = 0;
    for (const c of r.citations) {
      const [id, part] = c.split("#");
      const chunkId = part?.startsWith("c") ? `${id}:${part.slice(1)}` : null;
      const [row] = chunkId
        ? await sql<{ text: string }[]>`select text from chunks where id = ${chunkId}`
        : await sql<{ text: string }[]>`select string_agg(text, ' ') as text from chunks where source_id = ${id!} or page_id = ${id!}`;
      if (row?.text && supports(row.text, q.answer)) good++;
    }
    const contra = contradictions.find((c) => q.factIds.includes(c.factId));
    askRows.push({
      q,
      correct: answered(r.answer, q.answer),
      answer: r.answer,
      cites: r.citations.length,
      goodCites: good,
      unknown: r.unknown.length,
      tokens: r.tokens,
      ms: Date.now() - st,
      ...(contra
        ? {
            contradiction: {
              noticed: /discord|conflitt|contrast|divers|incongru|non coincid|invece|mentre/i.test(r.answer),
              both: contains(r.answer, contra.statedValue) && contains(r.answer, contra.trueValue),
            },
          }
        : {}),
    });
    log(`ask ${q.id} ${answered(r.answer, q.answer) ? "✓" : "✗"} ${r.citations.length} citazioni (${good} pertinenti) ${Date.now() - st} ms`);
  }
}
const askN = askRows.length;
const askCorrect = askRows.filter((r) => r.correct).length / Math.max(1, askN);
const allCites = askRows.reduce((a, r) => a + r.cites, 0);
const citePrecision = askRows.reduce((a, r) => a + r.goodCites, 0) / Math.max(1, allCites);
const contraRows = askRows.filter((r) => r.contradiction);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
const md = [
  `# Fase 6 — eval di recupero sul corpus sintetico`,
  ``,
  `Run \`${run}\` · ${new Date().toISOString()} · corpus seed ${manifest.seed}: ${files.length} documenti, ${questions.length} domande · ${chunks} chunk, ${tokens.toLocaleString("it-IT")} token · modelli: ${eps.map((e) => `${e.id} ${e.status}`).join(", ")}`,
  ``,
  `## Ricerca (brain_search, top 5, ibrida + reranker, account con clearance interno)`,
  ``,
  `| Misura | Valore |`,
  `|---|---|`,
  `| recall@5 (almeno una fonte attesa tra i primi 5) | **${recall5.toFixed(3)}** |`,
  `| hit@1 | ${hit1.toFixed(3)} |`,
  `| MRR | ${mrr.toFixed(3)} |`,
  `| Token medi per risposta di brain_search | ${avgTok.toFixed(0)} |`,
  `| Latenza mediana (cache fredda) | ${p50} ms |`,
  ``,
  `| Tipo di domanda | Domande | recall@5 | hit@1 | tutte le fonti in top 5 |`,
  `|---|---|---|---|---|`,
  ...[...byKind.entries()].map(([k, rs]) => `| ${k} | ${rs.length} | ${(rs.filter((r) => r.rank).length / rs.length).toFixed(3)} | ${(rs.filter((r) => r.rank === 1).length / rs.length).toFixed(3)} | ${(rs.filter((r) => r.all5).length / rs.length).toFixed(3)} |`),
  ``,
  `## Classificazione`,
  ``,
  `| Controllo | Esito |`,
  `|---|---|`,
  `| Canarini «riservato» restituiti (ricerca mirata + lettura per id) | ${canaryLeaks} su ${canaries.length} |`,
  `| Risposte di ricerca con elementi sopra «interno» | ${aboveInterno} su ${rows.length} |`,
  ``,
  `## Risposte del modello locale (brain_ask)`,
  ``,
  ...(askN
    ? [
        `| Misura | Valore |`,
        `|---|---|`,
        `| Domande | ${askN} |`,
        `| Risposte corrette (il valore atteso; per gli elenchi almeno l'80% degli elementi) | ${pct(askCorrect)} |`,
        `| Precisione delle citazioni (il passo citato contiene il valore atteso o un elemento dell'elenco) | ${pct(citePrecision)} (${allCites} citazioni) |`,
        `| Citazioni a id non forniti | ${askRows.reduce((a, r) => a + r.unknown, 0)} |`,
        `| Token medi del modello per risposta | ${(askRows.reduce((a, r) => a + r.tokens, 0) / askN).toFixed(0)} |`,
        `| Tempo medio | ${(askRows.reduce((a, r) => a + r.ms, 0) / askN / 1000).toFixed(1).replace(".", ",")} s |`,
        `| Contraddizioni volute: risposte con entrambi i valori | ${contraRows.filter((r) => r.contradiction!.both).length} su ${contraRows.length} |`,
        `| Contraddizioni volute: dette esplicitamente (discordanza, conflitto…) | ${contraRows.filter((r) => r.contradiction!.noticed).length} su ${contraRows.length} |`,
      ]
    : [chatUp ? "Nessuna domanda eseguita." : "Modello di chat non disponibile: parte saltata."]),
  ``,
  `## Domande non trovate nei primi 5`,
  ``,
  ...rows
    .filter((r) => !r.rank)
    .slice(0, 40)
    .map((r) => `- ${r.q.id} (${r.q.kind}) «${r.q.question}» — attese: ${r.q.sources.join(", ")}; trovate: ${r.top.slice(0, 3).join(", ")}`),
  ``,
].join("\n");
await mkdir("docs/spikes", { recursive: true });
await writeFile("docs/spikes/phase6-eval.md", md);
await writeFile(path.join("data", `phase6-eval-${run}.json`), JSON.stringify({ rows: rows.map((r) => ({ id: r.q.id, kind: r.q.kind, rank: r.rank, top: r.top, tokens: r.tokens })), ask: askRows.map((r) => ({ id: r.q.id, question: r.q.question, expected: r.q.answer, answer: r.answer, correct: r.correct, cites: r.cites, good: r.goodCites, contradiction: r.contradiction })) }, null, 2));
log("rapporto: docs/spikes/phase6-eval.md");

if (!KEEP) await s.vaults.delete(vault.id);
await s.stop();
process.exit(0);
