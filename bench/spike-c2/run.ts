/**
 * Spike C2 — alternatives for the two weak points found in spike C.
 *
 *   --target paradedb   full-text: tsvector + GIN + ts_rank_cd  vs  ParadeDB index (BM25, Tantivy)
 *   --target timescale  vectors:   pgvector HNSW on binary_quantize + rescoring
 *                                  vs pgvectorscale StreamingDiskANN (SBQ), also with vault labels
 *
 * Synthetic chunks with a long-tail vocabulary (rare names and codes, Zipf), one table with a
 * vault_id column (20 vaults). Queries for 3 allowed vaults and for all 20.
 *
 * Usage: npm run spike:c2 -- --target paradedb  --url postgres://brain:brain@127.0.0.1:5433/brain
 *        npm run spike:c2 -- --target timescale --url postgres://brain:brain@127.0.0.1:5434/brain
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDb, type Sql } from "@cb/db";
import { SyntheticSpace } from "../spike-c/data.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const TARGET = opt("target", "paradedb") as "paradedb" | "timescale";
const URL_ = opt("url", TARGET === "paradedb" ? "postgres://brain:brain@127.0.0.1:5433/brain" : "postgres://brain:brain@127.0.0.1:5434/brain");
const ROWS = Number(opt("rows", "1000000"));
const DIMS = 1024;
const VAULTS = 20;
const QUERIES = Number(opt("queries", "200"));
const WRITERS = 8;
const ALLOWED = [2, 7, 13];
const ALL = Array.from({ length: VAULTS }, (_, i) => i);

const sql = createDb({ url: URL_, max: WRITERS + 2, application: "spike-c2" });
const space = new SyntheticSpace(DIMS, 4096).withRareVocabulary(100_000);
const out: string[] = [];
const log = (s = "") => {
  console.log(s);
  out.push(s);
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const fmt = (xs: number[]) => `${pct(xs, 0.5).toFixed(1)} / ${pct(xs, 0.95).toFixed(1)} / ${pct(xs, 0.99).toFixed(1)}`;
const gb = (b: number) => `${(Number(b) / 1024 ** 3).toFixed(2)} GB`;
const timeIt = async (fn: () => Promise<unknown>) => {
  const t = performance.now();
  await fn();
  return (performance.now() - t) / 1000;
};
async function sizeOf(rel: string): Promise<number> {
  const [r] = await sql<{ b: number }[]>`select pg_relation_size(${rel}::regclass)::bigint as b`;
  return Number(r!.b);
}
async function timed(fn: (i: number) => Promise<unknown>, n = QUERIES): Promise<number[]> {
  const ts: number[] = [];
  for (let i = 0; i < n + 20; i++) {
    const t = performance.now();
    await fn(i);
    if (i >= 20) ts.push(performance.now() - t);
  }
  return ts;
}

// ---------------------------------------------------------------------------
// Binary COPY row: (int4 vault_id, int8 id, text, [vector])
// ---------------------------------------------------------------------------
function row(vault: number, id: number, text: string, vec?: Float32Array, kind: "vector" | "halfvec" = "vector"): Buffer {
  const t = Buffer.from(text, "utf8");
  const n = vec ? (kind === "vector" ? 4 + vec.length * 4 : 4 + vec.length * 2) : 0;
  const b = Buffer.allocUnsafe(2 + 8 + 12 + 4 + t.length + (vec ? 4 + n : 0));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  dv.setInt16(o, vec ? 4 : 3); o += 2;
  dv.setInt32(o, 4); o += 4; dv.setInt32(o, vault); o += 4;
  dv.setInt32(o, 8); o += 4; dv.setBigInt64(o, BigInt(id)); o += 8;
  dv.setInt32(o, t.length); o += 4; t.copy(b, o); o += t.length;
  if (vec) {
    dv.setInt32(o, n); o += 4;
    dv.setInt16(o, vec.length); o += 2; dv.setInt16(o, 0); o += 2;
    for (let i = 0; i < vec.length; i++) {
      if (kind === "vector") { dv.setFloat32(o, vec[i]!); o += 4; } else { dv.setFloat16(o, vec[i]!); o += 2; }
    }
  }
  return b;
}

async function load(table: string, cols: string, withVec: boolean): Promise<number> {
  const per = Math.ceil(ROWS / WRITERS);
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: WRITERS }, async (_, w) => {
      const vec = new Float32Array(DIMS);
      function* gen() {
        yield Buffer.concat([Buffer.from("PGCOPY\n\xff\r\n\0", "latin1"), Buffer.alloc(8)]);
        for (let id = w * per; id < Math.min(ROWS, (w + 1) * per); id++) {
          const topic = space.topicOf();
          yield row(id % VAULTS, id, space.text(topic, withVec ? 200 : 700), withVec ? space.vector(topic, vec) : undefined);
        }
        yield Buffer.from([0xff, 0xff]);
      }
      const writable = await sql.unsafe(`copy ${table} (${cols}) from stdin with (format binary)`).writable();
      await pipeline(Readable.from(gen()), writable);
    }),
  );
  return ROWS / ((performance.now() - t0) / 1000);
}

// Queries: half "rare word + keyword" (selective, like a name or a code), half common words.
function queryText(i: number): { text: string; kind: "rare" | "common" } {
  const t = space.topics[space.topicOf()]!;
  return i % 2 === 0 ? { text: `${space.rareWord()} ${t.keywords[0]}`, kind: "rare" } : { text: `${t.keywords[0]} ${t.keywords[1]} ${t.name}`, kind: "common" };
}

// ===========================================================================
if (TARGET === "paradedb") {
  const [{ v }] = (await sql`select extversion as v from pg_extension where extname = 'pg_search'`) as unknown as [{ v: string }];
  log(`# Spike C2 — full-text: tsvector vs ParadeDB\n`);
  log(`${new Date().toISOString()} · ParadeDB pg_search ${v} · ${ROWS.toLocaleString("it-IT")} chunk (~700 caratteri, vocabolario a coda lunga) · ${VAULTS} vault in una tabella\n`);
  await sql`drop table if exists c2_text`;
  await sql`create table c2_text (vault_id int not null, id bigint primary key, text text not null,
            tsv tsvector generated always as (to_tsvector('italian', text)) stored)`;
  log(`- Caricamento: ${(await load("c2_text", "vault_id, id, text", false)).toFixed(0)} righe/s`);
  log(`- GIN su tsvector: build ${(await timeIt(() => sql`create index c2_gin on c2_text using gin (tsv)`)).toFixed(0)} s, ${gb(await sizeOf("c2_gin"))}`);
  let pdbIndex = "";
  for (const variant of [
    `create index c2_pdb on c2_text using paradedb (id, vault_id, (text::pdb.simple('stemmer=italian')))`,
    `create index c2_pdb on c2_text using paradedb (id, vault_id, text)`,
  ]) {
    try {
      const s = await timeIt(() => sql.unsafe(variant));
      pdbIndex = variant;
      log(`- Indice ParadeDB: build ${s.toFixed(0)} s, ${gb(await sizeOf("c2_pdb"))} — \`${variant.replace(/^create index c2_pdb on c2_text /, "")}\``);
      break;
    } catch (e) {
      log(`- variante non supportata: \`${variant}\` (${String((e as Error).message).slice(0, 120)})`);
    }
  }
  await sql`vacuum analyze c2_text`;

  const tsQuery = (q: string, vaults: number[]) => sql`
    select id from c2_text, websearch_to_tsquery('italian', ${q}) qq
    where vault_id = any(${vaults}) and tsv @@ qq order by ts_rank_cd(tsv, qq, 32) desc limit 200`;
  const tsQueryOr = (q: string, vaults: number[]) => sql`
    select id from c2_text, to_tsquery('italian', ${q.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).join(" | ")}) qq
    where vault_id = any(${vaults}) and tsv @@ qq order by ts_rank_cd(tsv, qq, 32) desc limit 200`;
  const pdbQuery = (q: string, vaults: number[]) => sql`
    select id from c2_text where text ||| ${q} and vault_id = any(${vaults}) order by pdb.score(id) desc limit 200`;

  log(`\n| Query (top 200) | Tipo | 3 vault | 20 vault |\n|---|---|---|---|`);
  for (const kind of ["rare", "common"] as const) {
    const qs = Array.from({ length: QUERIES * 4 }, (_, i) => queryText(i)).filter((q) => q.kind === kind).map((q) => q.text);
    const run = (fn: (q: string, v: number[]) => PromiseLike<unknown>, v: number[]) => timed(async (i) => fn(qs[i % qs.length]!, v));
    log(`| tsvector AND (websearch) + ts_rank_cd | ${kind} | ${fmt(await run(tsQuery, ALLOWED))} | ${fmt(await run(tsQuery, ALL))} |`);
    log(`| tsvector OR + ts_rank_cd | ${kind} | ${fmt(await run(tsQueryOr, ALLOWED))} | ${fmt(await run(tsQueryOr, ALL))} |`);
    if (pdbIndex) log(`| ParadeDB OR (\`|||\`) + BM25 | ${kind} | ${fmt(await run(pdbQuery, ALLOWED))} | ${fmt(await run(pdbQuery, ALL))} |`);
  }
  // agreement of the two rankings on the first 10 results (OR semantics on both sides)
  if (pdbIndex) {
    let overlap = 0;
    const n = 50;
    for (let i = 0; i < n; i++) {
      const q = queryText(i).text;
      const a = new Set(((await tsQueryOr(q, ALL)) as unknown as { id: number }[]).slice(0, 10).map((r) => Number(r.id)));
      const b = ((await pdbQuery(q, ALL)) as unknown as { id: number }[]).slice(0, 10).map((r) => Number(r.id));
      overlap += b.filter((x) => a.has(x)).length / Math.max(1, Math.min(10, a.size));
    }
    log(`\n- Sovrapposizione dei primi 10 (ts_rank_cd OR vs BM25): ${((overlap / n) * 100).toFixed(0)}% — i due ranking sono diversi per costruzione (BM25 pesa la rarità dei termini).`);
  }
  log(`\nLatenze p50 / p95 / p99 in ms dal client Node, ${QUERIES} query per cella dopo 20 di riscaldamento.`);
}

// ===========================================================================
if (TARGET === "timescale") {
  await sql`create extension if not exists vectorscale cascade`;
  const exts = await sql<{ extname: string; extversion: string }[]>`select extname, extversion from pg_extension where extname in ('vector', 'vectorscale')`;
  log(`# Spike C2 — vettori: pgvector HNSW binario vs pgvectorscale DiskANN\n`);
  log(`${new Date().toISOString()} · ${exts.map((e) => `${e.extname} ${e.extversion}`).join(", ")} · ${ROWS.toLocaleString("it-IT")} vettori 1024 dim · ${VAULTS} vault in una tabella\n`);
  await sql`drop table if exists c2_vec`;
  await sql.unsafe(`create table c2_vec (vault_id int not null, id bigint primary key, text text not null, emb vector(${DIMS}) not null,
                    labels smallint[] generated always as (array[vault_id::smallint]) stored)`);
  log(`- Caricamento: ${(await load("c2_vec", "vault_id, id, text, emb", true)).toFixed(0)} righe/s`);
  await sql`analyze c2_vec`;

  const binExpr = `(binary_quantize(emb::halfvec(${DIMS}))::bit(${DIMS}))`;
  log(`- pgvector HNSW binario: build ${(await timeIt(() => sql.unsafe(`create index c2_hnsw_bin on c2_vec using hnsw (${binExpr} bit_hamming_ops) with (m = 16, ef_construction = 64)`))).toFixed(0)} s, ${gb(await sizeOf("c2_hnsw_bin"))}`);
  log(`- DiskANN (SBQ, memory_optimized): build ${(await timeIt(() => sql.unsafe(`create index c2_diskann on c2_vec using diskann (emb vector_cosine_ops)`))).toFixed(0)} s, ${gb(await sizeOf("c2_diskann"))}`);
  let labels = false;
  try {
    log(`- DiskANN con etichette (vault): build ${(await timeIt(() => sql.unsafe(`create index c2_diskann_lab on c2_vec using diskann (emb vector_cosine_ops, labels)`))).toFixed(0)} s, ${gb(await sizeOf("c2_diskann_lab"))}`);
    labels = true;
  } catch (e) {
    log(`- DiskANN con etichette non disponibile: ${String((e as Error).message).slice(0, 120)}`);
  }

  const lit = (v: Float32Array) => `[${Array.from(v, (x) => x.toFixed(5)).join(",")}]`;
  const queries = Array.from({ length: QUERIES + 20 }, () => lit(space.query(space.topicOf()).vector));
  const only = async <T>(index: string, settings: string[], fn: (tx: Sql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      // force the chosen index: drop the others for this transaction only
      for (const other of ["c2_hnsw_bin", "c2_diskann", "c2_diskann_lab"].filter((x) => x !== index)) {
        await tx.unsafe(`drop index if exists ${other}`);
      }
      for (const s of settings) await tx.unsafe(`set local ${s}`);
      const r = await fn(tx as unknown as Sql);
      throw Object.assign(new Error("rollback"), { result: r }); // undo the drops
    }).catch((e) => {
      if (e.result !== undefined) return e.result as T;
      throw e;
    });

  type Q = (tx: Sql, q: string, vaults: number[]) => Promise<{ id: number }[]>;
  const hnswBin: Q = (tx, q, v) =>
    tx.unsafe(
      `select id from (select id, emb from c2_vec where vault_id = any($2) order by ${binExpr} <~> binary_quantize($1::halfvec(${DIMS})) limit 200) x
       order by emb <=> $1::vector limit 10`,
      [q, v],
    ) as never;
  const disk: Q = (tx, q, v) => tx.unsafe(`select id from c2_vec where vault_id = any($2) order by emb <=> $1::vector limit 10`, [q, v]) as never;
  const diskLab: Q = (tx, q, v) => tx.unsafe(`select id from c2_vec where labels && $2::smallint[] order by emb <=> $1::vector limit 10`, [q, v]) as never;
  const exact = async (q: string, v: number[]) =>
    sql.begin(async (tx) => {
      await tx`set local enable_indexscan = off`;
      await tx`set local enable_bitmapscan = off`;
      return tx.unsafe(`select id from c2_vec where vault_id = any($2) order by emb <=> $1::vector limit 10`, [q, v]) as unknown as Promise<{ id: number }[]>;
    });

  const variants: [string, string, string[], Q][] = [
    ["pgvector HNSW binario + rescoring 200", "c2_hnsw_bin", ["hnsw.ef_search = 200", "hnsw.iterative_scan = relaxed_order"], hnswBin],
    ["DiskANN (rescore 200)", "c2_diskann", ["diskann.query_rescore = 200"], disk],
  ];
  if (labels) variants.push(["DiskANN con etichette (rescore 200)", "c2_diskann_lab", ["diskann.query_rescore = 200"], diskLab]);

  // exact neighbors for recall, once per query and scenario
  const truth = new Map<string, Set<number>>();
  for (const [scen, v] of [["3", ALLOWED], ["20", ALL]] as const) {
    for (let i = 0; i < 40; i++) truth.set(`${scen}:${i}`, new Set((await exact(queries[i]!, [...v])).map((r) => Number(r.id))));
  }

  log(`\n| Indice | 3 vault p50/p95/p99 ms | 20 vault p50/p95/p99 ms | recall@10 (3 / 20 vault) |\n|---|---|---|---|`);
  for (const [name, index, settings, q] of variants) {
    const lat: Record<string, number[]> = {};
    const rec: Record<string, number> = {};
    for (const [scen, v] of [["3", ALLOWED], ["20", ALL]] as const) {
      const res = await only(index, settings, async (tx) => {
        const ts: number[] = [];
        let hit = 0;
        for (let i = 0; i < queries.length; i++) {
          const t = performance.now();
          const r = await q(tx, queries[i]!, [...v]);
          if (i >= 20) ts.push(performance.now() - t);
          if (i < 40) {
            const tr = truth.get(`${scen}:${i}`)!;
            hit += r.filter((x) => tr.has(Number(x.id))).length;
          }
        }
        return { ts, recall: hit / 400 };
      });
      lat[scen] = res.ts;
      rec[scen] = res.recall;
    }
    log(`| ${name} | ${fmt(lat["3"]!)} | ${fmt(lat["20"]!)} | ${(rec["3"]! * 100).toFixed(1)}% / ${(rec["20"]! * 100).toFixed(1)}% |`);
  }
  log(`\nLatenze dal client Node, ${QUERIES} query dopo 20 di riscaldamento. Ogni variante gira con le altre due indici rimossi nella stessa transazione (rollback alla fine), così il planner non può scegliere un altro indice.`);
}

await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
await writeFile(path.resolve(here, `../../docs/spikes/spike-c2-${TARGET}.md`), out.join("\n") + "\n");
await sql.end();
