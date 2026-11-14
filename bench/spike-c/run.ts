/**
 * Spike C — scale of PostgreSQL + pgvector for the hybrid search (plan §3.5, §6.1).
 *
 * Loads synthetic chunks (text + halfvec) into a table partitioned by vault, then at each
 * checkpoint measures: load speed, index build time, size on disk by component, latency
 * (p50/p95/p99) of full-text, vector and hybrid (RRF) queries for two ACL scenarios
 * (3 allowed vaults out of 20, and all vaults), and HNSW recall@10 against exact search.
 * At the first checkpoint it also compares halfvec(1024), halfvec(512) and binary + rescoring.
 *
 * Usage: npm run spike:c -- --checkpoints 1000000,2000000,5000000 --vaults 20 --dims 1024
 * Re-running continues from the rows already loaded (use --reset to start again).
 */
import "../../packages/db/src/env.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createDb, type Sql } from "@cb/db";
import { COPY_HEADER, COPY_TRAILER, encodeRow, SyntheticSpace, vecLiteral } from "./data.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const opt = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const CHECKPOINTS = opt("checkpoints", "1000000,2000000,5000000").split(",").map(Number);
const VAULTS = Number(opt("vaults", "20"));
const DIMS = Number(opt("dims", "1024"));
const TOPICS = Number(opt("topics", "4096"));
const QUERIES = Number(opt("queries", "200"));
const RECALL_QUERIES = Number(opt("recall-queries", "30"));
const WRITERS = Number(opt("writers", "8"));
const RESET = process.argv.includes("--reset");
const ALLOWED = [2, 7, 13]; // ACL scenario: 3 of 20 vaults

const sql = createDb({ max: WRITERS + 2, application: "spike-c" });
const space = new SyntheticSpace(DIMS, TOPICS);
const report: string[] = [];
const log = (s: string) => {
  console.log(s);
  report.push(s);
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
if (RESET) await sql`drop schema if exists spike_c cascade`;
await sql`create schema if not exists spike_c`;
await sql.unsafe(`
  create table if not exists spike_c.chunks (
    vault_id int not null,
    id bigint not null,
    text text not null,
    tsv tsvector generated always as (to_tsvector('italian', text)) stored,
    emb halfvec(${DIMS}) not null,
    primary key (vault_id, id)
  ) partition by list (vault_id)`);
for (let v = 0; v < VAULTS; v++) {
  await sql.unsafe(`create table if not exists spike_c.chunks_v${v} partition of spike_c.chunks for values in (${v})`);
}

const count = async () => ((await sql`select count(*)::bigint as n from spike_c.chunks`)[0] as { n: number }).n;

// ---------------------------------------------------------------------------
// Load with parallel binary COPY streams (one writer = a set of vaults)
// ---------------------------------------------------------------------------
async function load(from: number, to: number): Promise<number> {
  const t0 = performance.now();
  const per = Math.ceil((to - from) / WRITERS);
  await Promise.all(
    Array.from({ length: WRITERS }, async (_, w) => {
      const start = from + w * per;
      const end = Math.min(to, start + per);
      if (start >= end) return;
      const vec = new Float32Array(DIMS);
      function* rows() {
        yield COPY_HEADER;
        for (let id = start; id < end; id++) {
          const topic = space.topicOf();
          yield encodeRow(id % VAULTS, id, space.text(topic), space.vector(topic, vec));
        }
        yield COPY_TRAILER;
      }
      const writable = await sql`copy spike_c.chunks (vault_id, id, text, emb) from stdin with (format binary)`.writable();
      await pipeline(Readable.from(rows(), { objectMode: false }), writable);
    }),
  );
  const s = (performance.now() - t0) / 1000;
  return (to - from) / s;
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------
async function sizes(): Promise<Record<string, number>> {
  // Partition indexes are attached to the parent index: group their sizes by the parent name.
  const rows = await sql<{ kind: string; bytes: number }[]>`
    with parts as (select i.inhrelid as oid from pg_inherits i where i.inhparent = 'spike_c.chunks'::regclass)
    select 'heap+toast' as kind, sum(pg_table_size(oid))::bigint as bytes from parts
    union all
    select am.amname || ':' || pi.relname, sum(pg_relation_size(ic.oid))::bigint
    from parts p
    join pg_index x on x.indrelid = p.oid
    join pg_class ic on ic.oid = x.indexrelid
    join pg_am am on am.oid = ic.relam
    join pg_inherits ii on ii.inhrelid = ic.oid
    join pg_class pi on pi.oid = ii.inhparent
    group by 1`;
  return Object.fromEntries(rows.map((r) => [r.kind, r.bytes]));
}
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
interface Lat {
  p50: number;
  p95: number;
  p99: number;
}
function pct(xs: number[]): Lat {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
const fmt = (l: Lat) => `${l.p50.toFixed(1)} / ${l.p95.toFixed(1)} / ${l.p99.toFixed(1)}`;

type QueryFn = (q: { text: string; vec: string }, vaults: number[]) => PromiseLike<unknown>;

async function timed(name: string, fn: QueryFn, vaults: number[], n = QUERIES): Promise<Lat> {
  const qs = Array.from({ length: n + 20 }, () => space.query(space.topicOf()));
  const times: number[] = [];
  for (let i = 0; i < qs.length; i++) {
    const q = { text: qs[i]!.text, vec: vecLiteral(qs[i]!.vector) };
    const t = performance.now();
    await fn(q, vaults);
    if (i >= 20) times.push(performance.now() - t); // first 20 = warm-up
  }
  void name;
  return pct(times);
}

const withSettings = async <T>(settings: string[], fn: (tx: Sql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    for (const s of settings) await tx.unsafe(`set local ${s}`);
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

const fts: QueryFn = (q, v) => sql`
  select id from spike_c.chunks, websearch_to_tsquery('italian', ${q.text}) query
  where vault_id = any(${v}) and tsv @@ query
  order by ts_rank_cd(tsv, query) desc limit 50`;

const vec =
  (ef: number, column = "emb", cast = `halfvec(${DIMS})`): QueryFn =>
  (q, v) =>
    withSettings([`hnsw.ef_search = ${ef}`], (tx) =>
      tx.unsafe(`select id from spike_c.chunks where vault_id = any($1) order by ${column} <=> $2::${cast} limit 50`, [v, q.vec]),
    );

const hybrid =
  (ef: number): QueryFn =>
  (q, v) =>
    withSettings([`hnsw.ef_search = ${ef}`], (tx) =>
      tx.unsafe(
        `with f as (
           select vault_id, id, row_number() over (order by ts_rank_cd(tsv, query) desc) as r
           from spike_c.chunks, websearch_to_tsquery('italian', $1) query
           where vault_id = any($3) and tsv @@ query
           order by ts_rank_cd(tsv, query) desc limit 200),
         v as (
           select vault_id, id, row_number() over () as r from (
             select vault_id, id from spike_c.chunks where vault_id = any($3)
             order by emb <=> $2::halfvec(${DIMS}) limit 200) x)
         select vault_id, id, coalesce(1.0 / (60 + f.r), 0) + coalesce(1.0 / (60 + v.r), 0) as score
         from f full join v using (vault_id, id) order by score desc limit 20`,
        [q.text, q.vec, v],
      ),
    );

async function recall(fn: QueryFn, vaults: number[], n = RECALL_QUERIES): Promise<number> {
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const qv = space.query(space.topicOf());
    const q = { text: qv.text, vec: vecLiteral(qv.vector) };
    const exact = (await withSettings(["enable_indexscan = off", "enable_bitmapscan = off", "max_parallel_workers_per_gather = 4"], (tx) =>
      tx.unsafe(`select id from spike_c.chunks where vault_id = any($1) order by emb <=> $2::halfvec(${DIMS}) limit 10`, [vaults, q.vec]),
    )) as { id: number }[];
    const approx = ((await fn(q, vaults)) as { id: number }[]).slice(0, 10);
    const set = new Set(exact.map((r) => Number(r.id)));
    hit += approx.filter((r) => set.has(Number(r.id))).length;
  }
  return hit / (n * 10);
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await fn();
  return (performance.now() - t) / 1000;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const all = Array.from({ length: VAULTS }, (_, i) => i);
log(`# Spike C — PostgreSQL + pgvector at scale\n`);
log(`${new Date().toISOString()} · PostgreSQL 17 + pgvector 0.8 (Docker, VM 32 GB, shared_buffers 8 GB) · ${VAULTS} vault partitions · halfvec(${DIMS}) · ${TOPICS} topics · chunks ≈ 700 characters\n`);
log(`Latency columns: p50 / p95 / p99 in ms, measured from the Node client (${QUERIES} queries after 20 warm-up). ACL "3 vault" = 3 of ${VAULTS} vaults allowed (partition pruning); "tutti" = all vaults.\n`);

let have = await count();
let firstCheckpoint = true;
for (const target of CHECKPOINTS) {
  if (have < target) {
    const hasHnsw = (await sql`select 1 from pg_indexes where schemaname = 'spike_c' and indexdef ilike '%hnsw%' limit 1`).length > 0;
    process.stdout.write(`loading ${have} -> ${target} (${hasHnsw ? "with" : "without"} HNSW) ... `);
    const rate = await load(have, target);
    console.log(`${rate.toFixed(0)} rows/s`);
    log(`\n## ${(target / 1e6).toFixed(1)}M chunks\n\n- Load: ${rate.toFixed(0)} rows/s (${WRITERS} parallel binary COPY streams, ${hasHnsw ? "HNSW and GIN maintained during the load" : "before the indexes"})`);
    have = target;
  } else {
    log(`\n## ${(target / 1e6).toFixed(1)}M chunks\n\n- Load: already present`);
  }

  const existing = new Set((await sql<{ indexname: string }[]>`select indexname from pg_indexes where tablename = 'chunks' and schemaname = 'spike_c'`).map((r) => r.indexname));
  if (!existing.has("chunks_tsv_gin")) {
    log(`- GIN build: ${(await timeIt(() => sql`create index chunks_tsv_gin on spike_c.chunks using gin (tsv)`)).toFixed(0)} s`);
  }
  if (!existing.has("chunks_emb_hnsw")) {
    log(`- HNSW halfvec(${DIMS}) build (m=16, ef_construction=64): ${(await timeIt(() => sql.unsafe(`create index chunks_emb_hnsw on spike_c.chunks using hnsw (emb halfvec_cosine_ops) with (m = 16, ef_construction = 64)`))).toFixed(0)} s`);
  }
  await sql`analyze spike_c.chunks`;

  const sz = await sizes();
  log(`- Size: ${Object.entries(sz).map(([k, v]) => `${k} ${gb(v)}`).join(" · ")} · total ${gb(Object.values(sz).reduce((a, b) => a + b, 0))}`);

  log(`\n| Query | ACL 3 vault | ACL tutti |\n|---|---|---|`);
  for (const [name, fn] of [
    ["Full-text (GIN, ts_rank_cd, top 50)", fts],
    ["Vettori HNSW ef_search=40", vec(40)],
    ["Vettori HNSW ef_search=100", vec(100)],
    ["Ibrida RRF (FTS 200 + HNSW 200, ef=40)", hybrid(40)],
  ] as const) {
    const a = await timed(name, fn, ALLOWED);
    const b = await timed(name, fn, all);
    log(`| ${name} | ${fmt(a)} | ${fmt(b)} |`);
  }
  const r40 = await recall(vec(40), all);
  const r100 = await recall(vec(100), all);
  const r40a = await recall(vec(40), ALLOWED);
  log(`\n- HNSW recall@10 vs exact search: ef=40 → ${(r40 * 100).toFixed(1)}% (tutti) / ${(r40a * 100).toFixed(1)}% (3 vault); ef=100 → ${(r100 * 100).toFixed(1)}% (tutti)`);

  if (firstCheckpoint) {
    firstCheckpoint = false;
    log(`\n### Variants at this size\n`);
    // halfvec(512): Matryoshka truncation (synthetic vectors are not Matryoshka-trained: recall
    // vs the 512-d exact search measures the index, not the semantic quality of truncation)
    await sql.unsafe(`alter table spike_c.chunks add column if not exists emb512 halfvec(512)`);
    const t512 = await timeIt(() => sql.unsafe(`update spike_c.chunks set emb512 = l2_normalize(subvector(emb, 1, 512))`));
    const b512 = await timeIt(() =>
      sql.unsafe(`create index if not exists chunks_emb512_hnsw on spike_c.chunks using hnsw (emb512 halfvec_cosine_ops) with (m = 16, ef_construction = 64)`),
    );
    const bBin = await timeIt(() =>
      sql.unsafe(`create index if not exists chunks_embbin_hnsw on spike_c.chunks using hnsw ((binary_quantize(emb)::bit(${DIMS})) bit_hamming_ops) with (m = 16, ef_construction = 64)`),
    );
    const sz2 = await sizes();
    log(`- halfvec(512): column fill ${t512.toFixed(0)} s, HNSW build ${b512.toFixed(0)} s, index ${gb(Object.entries(sz2).find(([k]) => k.includes("chunks_emb512_hnsw"))?.[1] ?? 0)}`);
    log(`- binary_quantize bit(${DIMS}): HNSW build ${bBin.toFixed(0)} s, index ${gb(Object.entries(sz2).find(([k]) => k.includes("chunks_embbin_hnsw"))?.[1] ?? 0)}`);
    const v512: QueryFn = (q, v) =>
      withSettings(["hnsw.ef_search = 40"], (tx) =>
        tx.unsafe(`select id from spike_c.chunks where vault_id = any($1) order by emb512 <=> l2_normalize(subvector($2::halfvec(${DIMS}), 1, 512)) limit 50`, [v, q.vec]),
      );
    const vBin: QueryFn = (q, v) =>
      withSettings(["hnsw.ef_search = 200"], (tx) =>
        tx.unsafe(
          `select id from (
             select id, emb from spike_c.chunks where vault_id = any($1)
             order by binary_quantize(emb)::bit(${DIMS}) <~> binary_quantize($2::halfvec(${DIMS})) limit 200) x
           order by emb <=> $2::halfvec(${DIMS}) limit 50`,
          [v, q.vec],
        ),
      );
    log(`\n| Variant | ACL 3 vault | ACL tutti | recall@10 (tutti) |\n|---|---|---|---|`);
    log(`| halfvec(1024) ef=40 (reference) | ${fmt(await timed("", vec(40), ALLOWED))} | ${fmt(await timed("", vec(40), all))} | ${(r40 * 100).toFixed(1)}% |`);
    log(`| halfvec(512) ef=40 | ${fmt(await timed("", v512, ALLOWED))} | ${fmt(await timed("", v512, all))} | ${((await recall(v512, all)) * 100).toFixed(1)}% (vs 1024-d exact) |`);
    log(`| binary + rescoring (top 200, ef=200) | ${fmt(await timed("", vBin, ALLOWED))} | ${fmt(await timed("", vBin, all))} | ${((await recall(vBin, all)) * 100).toFixed(1)}% |`);
    // keep only the reference index for the next checkpoints (disk budget, insert speed)
    await sql.unsafe(`drop index if exists spike_c.chunks_emb512_hnsw; drop index if exists spike_c.chunks_embbin_hnsw; alter table spike_c.chunks drop column if exists emb512`);
  }
  await writeReport();
}

async function writeReport() {
  await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
  await writeFile(path.resolve(here, "../../docs/spikes/spike-c.md"), report.join("\n") + "\n");
}
await writeReport();
await sql.end();
