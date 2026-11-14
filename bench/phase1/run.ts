/**
 * Phase 1 acceptance benchmark: the real query engine (SearchEngine + readPage) on 1M chunks.
 *
 * - 20 vaults (vector_index = binary, the default for large spaces), synthetic sources and
 *   chunks loaded with binary COPY, then the vector index built per partition (bulk import
 *   path of the plan: load first, index after).
 * - 5,000 compiled pages written through PageStore (links, aliases, blocks, chunks).
 * - The query embedding comes from a benchmark endpoint that returns the synthetic topic
 *   vector, so vector search has a ground truth like a real model.
 * - Measures end-to-end latency (embedding call + reader transaction + SQL + grouping +
 *   snippets), with the cache disabled, for 3 allowed vaults and for all 20.
 *
 * Usage: npm run bench:phase1 -- [--chunks 1000000] [--keep]
 */
import "../../packages/db/src/env.ts";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDb, migrate } from "@cb/db";
import { ModelDispatcher, type EmbedRequest, type EmbedResponse, type Endpoint } from "@cb/models";
import { estimateTokens, ulid } from "@cb/shared";
import { PageStore, readPage, SearchEngine, VaultStore, type Principal, type Vault } from "@cb/brain";
import { SyntheticSpace } from "../spike-c/data.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const CHUNKS = Number(opt("chunks", "1000000"));
const VAULTS = 20;
const DIMS = 1024;
const PAGES = Number(opt("pages", "5000"));
const QUERIES = Number(opt("queries", "200"));
const WRITERS = 8;
const KEEP = process.argv.includes("--keep");
/** --vocab tiny: 60 words (worst case for full-text). Default: long-tail vocabulary (realistic). */
const VOCAB = opt("vocab", "long") as "long" | "tiny";
const run = ulid().slice(-6).toLowerCase();
const MODEL = "bench-synthetic";

const sql = createDb({ max: WRITERS + 4, application: "bench-phase1" });
await migrate(sql);
const space = VOCAB === "long" ? new SyntheticSpace(DIMS, 4096).withRareVocabulary(100_000) : new SyntheticSpace(DIMS, 4096);
const report: string[] = [];
const log = (s = "") => {
  console.log(s);
  report.push(s);
};

// ---------------------------------------------------------------------------
// Benchmark embedding endpoint: query text -> topic vector (ground truth of the space)
// ---------------------------------------------------------------------------
const queryVectors = new Map<string, number[]>();
class BenchEndpoint implements Endpoint {
  readonly id = "bench";
  readonly kind = "embed" as const;
  readonly origin = "mock" as const;
  readonly url = "bench://";
  readonly slots = 8;
  async health() {
    return true;
  }
  async identity() {
    return { model: MODEL, dimensions: DIMS };
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return { vectors: req.texts.map((t) => queryVectors.get(t) ?? new Array(DIMS).fill(0)), model: MODEL, tokens: 0 };
  }
}
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new BenchEndpoint());

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------
log(`# Fase 1 — benchmark del query engine\n`);
log(`${new Date().toISOString()} · ${CHUNKS.toLocaleString("it-IT")} chunk di sorgenti + ${PAGES.toLocaleString("it-IT")} pagine compilate · ${VAULTS} vault · halfvec(${DIMS}), indice binario + rescoring · vocabolario ${VOCAB === "long" ? "a coda lunga (metà delle query con un termine raro)" : "minimo, 60 parole (caso peggiore per il full-text)"}\n`);
const vs = new VaultStore(sql, DIMS);
const vaults: Vault[] = [];
for (let i = 0; i < VAULTS; i++) vaults.push(await vs.create({ kind: "space", slug: `bench-${run}-${i}`, name: `Bench ${i}` }));

// ---------------------------------------------------------------------------
// Bulk load: sources + chunks (binary COPY), vector index dropped during the load
// ---------------------------------------------------------------------------
for (const v of vaults) await sql.unsafe(`drop index if exists ${v.chunksPartition}_vec_idx`);

const enc = (vault: string, id: string, source: string, ord: number, text: string, vec: Float32Array): Buffer => {
  const fields: Buffer[] = [];
  const str = (s: string) => Buffer.from(s, "utf8");
  const i32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const i16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
  };
  const hv = Buffer.alloc(4 + vec.length * 2);
  const dv = new DataView(hv.buffer, hv.byteOffset, hv.byteLength);
  dv.setInt16(0, vec.length);
  for (let k = 0; k < vec.length; k++) dv.setFloat16(4 + k * 2, vec[k]!);
  const hash = createHash("sha256").update(text).digest("hex");
  for (const f of [str(vault), str(id), str(source), i32(ord), str(text), i32(estimateTokens(text)), str(hash), i16(1), hv, str(MODEL)]) {
    fields.push(i32(f.length), f);
  }
  return Buffer.concat([i16(10), ...fields]);
};

const CHUNKS_PER_SOURCE = 10;
const t0 = performance.now();
const per = Math.ceil(CHUNKS / WRITERS);
await Promise.all(
  Array.from({ length: WRITERS }, async (_, w) => {
    const start = w * per;
    const end = Math.min(CHUNKS, start + per);
    // sources first (one per 10 chunks)
    const srcRows: { id: string; vault_id: string; sha256: string; name: string; mime: string; size: number; status: string; level: number }[] = [];
    for (let s = Math.floor(start / CHUNKS_PER_SOURCE); s * CHUNKS_PER_SOURCE < end; s++) {
      srcRows.push({ id: `src_b${run}_${s}`, vault_id: vaults[s % VAULTS]!.id, sha256: createHash("sha256").update(`${run}:${s}`).digest("hex"), name: `documento-${s}.pdf`, mime: "application/pdf", size: 100_000, status: "embedded", level: 2 });
    }
    for (let i = 0; i < srcRows.length; i += 2000) await sql`insert into sources ${sql(srcRows.slice(i, i + 2000))} on conflict do nothing`;
    const vec = new Float32Array(DIMS);
    function* rows() {
      yield Buffer.concat([Buffer.from("PGCOPY\n\xff\r\n\0", "latin1"), Buffer.alloc(8)]);
      for (let id = start; id < end; id++) {
        const s = Math.floor(id / CHUNKS_PER_SOURCE);
        const topic = space.topicOf();
        yield enc(vaults[s % VAULTS]!.id, `c${id}`, `src_b${run}_${s}`, id % CHUNKS_PER_SOURCE, space.text(topic), space.vector(topic, vec));
      }
      yield Buffer.from([0xff, 0xff]);
    }
    const writable = await sql`
      copy chunks (vault_id, id, source_id, ord, text, tokens, hash, classification, embedding, embedding_model)
      from stdin with (format binary)`.writable();
    await pipeline(Readable.from(rows()), writable);
  }),
);
const loadS = (performance.now() - t0) / 1000;
log(`- Caricamento: ${(CHUNKS / loadS).toFixed(0)} chunk/s (COPY binario, ${WRITERS} flussi, senza indice vettoriale)`);

const t1 = performance.now();
for (const v of vaults) await vs.setVectorIndex(v.id, "binary");
await sql`analyze chunks`;
log(`- Costruzione indice binario (20 partizioni): ${((performance.now() - t1) / 1000).toFixed(0)} s`);

// ---------------------------------------------------------------------------
// Compiled pages through PageStore (links between them)
// ---------------------------------------------------------------------------
const ps = new PageStore(sql);
const t2 = performance.now();
const pageIds: string[] = [];
for (let i = 0; i < PAGES; i++) {
  const topic = space.topicOf();
  const t = space.topics[topic]!;
  const title = `${t.name} ${t.keywords[0]} ${i}`;
  const linkTo = i > 0 ? `\n\nVedi anche [[${space.topics[space.topicOf()]!.name} ${t.keywords[1]} ${Math.floor(Math.random() * i)}]].` : "";
  const r = await ps.upsert({
    vaultId: vaults[i % VAULTS]!.id,
    markdown: `---\ntitle: ${title}\ntype: entity/company\n---\n${space.text(topic, 200)}\n\n## Stato attuale\n${space.text(topic, 500)}\n\n## Timeline\n- 2026-01-01 · ${space.text(topic, 120)}${linkTo}`,
  });
  pageIds.push(r.page.id);
}
const pagesS = (performance.now() - t2) / 1000;
log(`- Scrittura pagine con PageStore: ${(PAGES / pagesS).toFixed(0)} pagine/s (alias, blocchi, link, chunk; embedding non calcolati)`);

const [{ bytes }] = (await sql`
  select sum(pg_total_relation_size(c.oid))::bigint as bytes from pg_class c
  where c.relname in (select chunks_partition from vaults where slug like ${`bench-${run}-%`})`) as unknown as [{ bytes: number }];
log(`- Spazio dei chunk (tabelle + indici): ${(Number(bytes) / 1024 ** 3).toFixed(2)} GB\n`);

// ---------------------------------------------------------------------------
// Queries through the engine
// ---------------------------------------------------------------------------
const engine = new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MODEL, cacheSize: 0 });
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const fmt = (xs: number[]) => `${pct(xs, 0.5).toFixed(1)} / ${pct(xs, 0.95).toFixed(1)} / ${pct(xs, 0.99).toFixed(1)}`;

async function measure(p: Principal, n = QUERIES) {
  const times: number[] = [];
  let hits = 0;
  for (let i = 0; i < n + 20; i++) {
    const q = space.query(space.topicOf());
    // no suffix: with AND semantics every word must match, a counter would empty the full-text branch
    const text = VOCAB === "long" && i % 2 === 0 ? `${space.rareWord()} ${q.text.split(" ")[0]}` : q.text;
    queryVectors.set(text, Array.from(q.vector));
    const t = performance.now();
    const r = await engine.search(p, text, { limit: 10, maxTokens: 4000 });
    if (i >= 20) {
      times.push(performance.now() - t);
      hits += r.hits.length;
    }
    queryVectors.delete(text);
  }
  return { times, avgHits: hits / n };
}

const all: Principal = { id: "bench", vaults: vaults.map((v) => v.id), clearance: 3 };
const three: Principal = { id: "bench", vaults: [vaults[2]!.id, vaults[7]!.id, vaults[13]!.id], clearance: 3 };
const m3 = await measure(three);
const mAll = await measure(all);
log(`| Operazione (motore completo) | p50 / p95 / p99 ms | Note |`);
log(`|---|---|---|`);
log(`| Ricerca ibrida, 3 vault | ${fmt(m3.times)} | ${m3.avgHits.toFixed(1)} risultati in media |`);
log(`| Ricerca ibrida, 20 vault | ${fmt(mAll.times)} | ${mAll.avgHits.toFixed(1)} risultati in media |`);

const readTimes: number[] = [];
for (let i = 0; i < 200; i++) {
  const id = pageIds[Math.floor(Math.random() * pageIds.length)]!;
  const t = performance.now();
  await readPage(sql, all, id, { maxTokens: 800 });
  readTimes.push(performance.now() - t);
}
log(`| Lettura pagina con budget (800 token) | ${fmt(readTimes)} | |`);

const titleTimes: number[] = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  await engine.search(all, `${space.topics[i]!.name} ${space.topics[i]!.keywords[0]} ${i}`, { types: ["entity"], limit: 5 });
  titleTimes.push(performance.now() - t);
}
log(`| Ricerca per titolo, solo pagine | ${fmt(titleTimes)} | filtro type = entity |`);

const cached = new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MODEL });
const cq = space.query(1);
queryVectors.set(cq.text, Array.from(cq.vector));
await cached.search(all, cq.text);
const cTimes: number[] = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  await cached.search(all, cq.text);
  cTimes.push(performance.now() - t);
}
log(`| Ricerca ripetuta (cache) | ${fmt(cTimes)} | chiave = versioni dei vault |`);

// Where does the time go? pg_stat_statements over 40 searches on all vaults.
await sql`select pg_stat_statements_reset()`.catch(() => undefined);
await measure(all, 40);
const top = await sql<{ calls: number; mean: number; query: string }[]>`
  select calls::int, mean_exec_time::float as mean, left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 90) as query
  from pg_stat_statements where calls >= 10 order by total_exec_time desc limit 5`.catch(() => []);
if (top.length) {
  log(`\nStatement più costosi durante 40 ricerche su 20 vault (pg_stat_statements):\n`);
  log(`| Chiamate | Media ms | Statement |\n|---|---|---|`);
  for (const t of top) log(`| ${t.calls} | ${t.mean.toFixed(1)} | \`${t.query.replace(/\|/g, "\\|")}…\` |`);
}

log(`\nObiettivi del piano (§0.2): ricerca ibrida p95 < 200 ms sugli spazi consentiti, lettura pagina p95 < 20 ms.`);

await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
await writeFile(path.resolve(here, `../../docs/spikes/phase1-bench-${VOCAB}.md`), report.join("\n") + "\n");

if (!KEEP) {
  for (const v of vaults) await vs.delete(v.id);
  await sql`delete from sources where id like ${`src_b${run}_%`}`;
  console.log("benchmark data deleted (use --keep to keep it)");
}
dispatcher.stop();
await sql.end();
