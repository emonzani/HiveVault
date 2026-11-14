/**
 * Phase 7 acceptance: "dashboard fluide con 7 giorni di dati al minuto".
 *
 * 1. Writes N days of one-minute metrics for every metric of the 10 dashboards (about 400
 *    series: counters, gauges, latency histograms), with a working-day pattern, through the
 *    real registry (MetricsRegistry.drain) and store (MetricsStore.write).
 * 2. Builds the hourly and daily rollups.
 * 3. Times the batched query of every dashboard for 1 h, 24 h, 7 d and 30 d (median of 5),
 *    like POST /api/admin/metrics/query does.
 *
 * Usage: npx tsx bench/phase7/metrics-bench.ts [--db brain_bench] [--days 7] [--skip-write]
 * The default database is a separate one (brain_bench), created and migrated here. With
 * `--db brain` the same data fills the development database for a look at the dashboards.
 */
import "../../packages/db/src/env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { createDb, migrate } from "@cb/db";
import { MetricsStore } from "@cb/metrics";
import { MetricsRegistry } from "@cb/shared";
import { DASHBOARDS } from "../../packages/web/src/lib/dashboards.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const DB = arg("--db", "brain_bench");
const DAYS = Number(arg("--days", "7"));
const SKIP_WRITE = argv.includes("--skip-write");

const adminUrl = process.env.DATABASE_URL ?? "postgres://brain:brain@127.0.0.1:5432/brain";
const u = new URL(adminUrl);
u.pathname = `/${DB}`;
if (DB !== new URL(adminUrl).pathname.slice(1)) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const [exists] = await admin`select 1 from pg_database where datname = ${DB}`;
  if (!exists) await admin.unsafe(`create database ${DB}`);
  await admin.end();
}
const sql = createDb({ url: u.toString(), max: 10, application: "cb-bench7" });
await migrate(sql);
const store = new MetricsStore(sql, { minuteDays: 14 });

// ---------------------------------------------------------------------------
// Synthetic load: deterministic random numbers, a working-day curve
// ---------------------------------------------------------------------------
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const lognormal = (median: number, sigma = 0.6) => median * Math.exp(sigma * Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd()));
const poisson = (l: number) => {
  if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * (rnd() * 2 - 1) * 1.7));
  let k = 0;
  for (let p = Math.exp(-l), s = rnd(); s > p; s *= rnd()) k++;
  return k;
};
/** 0.05 at night, 1 in working hours on weekdays, 0.2 at weekends. */
function work(t: Date): number {
  const h = t.getHours() + t.getMinutes() / 60;
  const day = t.getDay();
  const office = h >= 8 && h < 19 ? Math.sin(((h - 8) / 11) * Math.PI) * 0.8 + 0.2 : 0.03;
  return day === 0 || day === 6 ? office * 0.2 : office;
}
const night = (t: Date) => t.getHours() >= 22 || t.getHours() < 6;

const ROUTES = ["/api/search", "/api/pages/:id/full", "/api/pages/:id", "/api/folders", "/api/me", "/api/auth/me", "/mcp", "/api/events", "/api/vaults/:vaultId/sources", "/api/suggest", "/api/pages/:id/backlinks", "/api/graph", "/api/inbox", "/api/curator", "/static"];
const FORMATS = ["pdf", "docx", "xlsx", "eml", "msg", "html", "txt", "pptx"];
const ENDPOINTS = [
  { id: "local-embed", kind: "embed", ms: 120 },
  { id: "local-rerank", kind: "rerank", ms: 380 },
  { id: "remote-chat", kind: "chat", ms: 9000 },
];
const SPACES = ["01JSPACECLIENTI0000000000", "01JSPACEPRODOTTI000000000", "01JSPACEPROGETTI000000000"];
const STEPS = ["reparse", "backlog", "dedup", "crosslink", "lint", "tldr", "promote", "importance", "indexes", "database", "backup", "report"];
const PHASES = ["parse", "store-text", "index", "embed", "compile"];
const VAULTS = Array.from({ length: 18 }, (_, i) => (i < 3 ? ["clienti", "prodotti", "progetti"][i]! : `cella-${i}`));

const state = { pages: 18_000, bytes: 42e9, docs: 61_000, disk: 210e9, broken: 340, orphans: 900 };

function minute(reg: MetricsRegistry, t: Date): void {
  const w = work(t);
  // HTTP
  for (const r of ROUTES) {
    const n = poisson((r === "/static" ? 30 : r === "/api/search" ? 25 : 8) * w + 0.2);
    if (!n) continue;
    reg.inc("http_requests", { route: r, method: "GET", status: "2xx" }, n);
    const e4 = poisson(n * 0.02);
    if (e4) reg.inc("http_requests", { route: r, method: "GET", status: "4xx" }, e4);
    if (rnd() < 0.003) reg.inc("http_requests", { route: r, method: "GET", status: "5xx" });
    for (let i = 0; i < Math.min(n, 40); i++) reg.observe("http_request_ms", lognormal(r === "/api/search" ? 600 : 25), { route: r });
  }
  // search
  const searches = poisson(25 * w + 0.1);
  for (let i = 0; i < searches; i++) {
    const hit = rnd() < 0.22;
    reg.inc("search_requests", { cache: hit ? "hit" : "miss", result: rnd() < 0.93 ? "hits" : "empty" });
    if (hit) {
      reg.observe("search_ms", lognormal(8), { branch: "total" });
      continue;
    }
    const e = lognormal(90);
    const s = lognormal(70);
    const rr = lognormal(420);
    reg.observe("search_ms", e, { branch: "embed" });
    reg.observe("search_ms", s, { branch: "sql" });
    reg.observe("search_ms", rr, { branch: "rerank" });
    reg.observe("search_ms", e + s + rr + lognormal(30), { branch: "total" });
    if (rnd() < 0.004) reg.inc("search_degraded", { branch: "rerank" });
  }
  // ingestion: uploads by day, imports and the backlog at night
  const docs = poisson(4 * w + (night(t) ? 6 : 0));
  for (let i = 0; i < docs; i++) {
    const f = FORMATS[Math.floor(rnd() ** 1.6 * FORMATS.length)]!;
    const ok = rnd() < 0.97;
    reg.inc("ingest_parsed", { format: f, outcome: ok ? "ok" : "failed" });
    const size = lognormal(f === "pdf" ? 900_000 : 120_000, 1);
    reg.inc("ingest_bytes", { format: f }, size);
    state.bytes += size;
    state.docs++;
    for (const ph of PHASES) reg.observe("task_phase_ms", lognormal(ph === "embed" ? 2200 : ph === "compile" ? 30_000 : 300), { task: "ingest", phase: ph });
    reg.inc("task_phases", { task: "ingest", outcome: ok ? "done" : "error" }, PHASES.length);
  }
  // models
  for (const ep of ENDPOINTS) {
    const n = ep.kind === "chat" ? poisson(0.6 * w + (night(t) ? 2 : 0)) : poisson(ep.kind === "embed" ? 30 * w + docs * 12 : 20 * w);
    if (!n) continue;
    reg.inc("model_items", { endpoint: ep.id, kind: ep.kind }, n * (ep.kind === "embed" ? 8 : 1));
    for (let i = 0; i < Math.min(n, 30); i++) reg.observe("model_request_ms", lognormal(ep.ms), { endpoint: ep.id, kind: ep.kind });
    if (ep.kind === "chat") {
      reg.inc("model_tokens", { endpoint: ep.id, type: "prompt" }, n * lognormal(3500));
      reg.inc("model_tokens", { endpoint: ep.id, type: "completion" }, n * lognormal(700));
    } else reg.inc("model_tokens", { endpoint: ep.id, type: "input" }, n * lognormal(300));
    if (rnd() < 0.002) reg.inc("model_errors", { endpoint: ep.id, kind: ep.kind });
    reg.set("model_endpoint_up", 1, { endpoint: ep.id, kind: ep.kind });
    reg.set("model_endpoint_latency_ms", lognormal(ep.ms, 0.2), { endpoint: ep.id, kind: ep.kind });
    reg.set("model_endpoint_items_per_sec", ep.kind === "chat" ? lognormal(38, 0.1) : lognormal(ep.kind === "embed" ? 85 : 12, 0.15), { endpoint: ep.id, kind: ep.kind });
    reg.set("model_endpoint_inflight", Math.min(4, poisson(n / 20)), { endpoint: ep.id, kind: ep.kind });
  }
  for (const k of ["embed", "rerank", "chat"]) for (const p of ["0", "1", "2"]) reg.set("model_queue", poisson((p === "0" ? 0.3 : p === "1" ? docs : night(t) ? 4 : 0.2) * (k === "embed" ? 1 : 0.3)), { kind: k, priority: p });
  reg.set("model_local_running", 1, { process: "local-embed" });
  reg.set("model_local_running", 1, { process: "local-rerank" });
  // dream cycle at night
  if (night(t) && rnd() < 0.5) {
    const step = STEPS[Math.floor(rnd() * STEPS.length)]!;
    reg.observe("dream_step_ms", lognormal(step === "backlog" || step === "tldr" ? 90_000 : 6000), { step });
    if (step === "tldr" || step === "dedup") reg.inc("dream_tokens", { step }, lognormal(9000));
    if (step === "promote") for (const s of SPACES) reg.inc("hive_promotions", { space: s, outcome: rnd() < 0.3 ? "written" : "unchanged" }, poisson(12));
  }
  // access, audit
  const reads = poisson(40 * w);
  reg.inc("reads", { via: "web", classification: "interno" }, Math.round(reads * 0.6));
  reg.inc("reads", { via: "mcp", classification: rnd() < 0.7 ? "interno" : "pubblico" }, Math.round(reads * 0.3));
  reg.inc("reads", { via: "api", classification: "interno" }, Math.round(reads * 0.1));
  reg.inc("audit_events", { action: "page.read", outcome: "ok" }, reads);
  if (rnd() < 0.05 * w) reg.inc("audit_events", { action: "login.totp", outcome: rnd() < 0.9 ? "ok" : "denied" });
  if (rnd() < 0.001) reg.inc("egress_blocked");
  reg.set("users_active", Math.round(35 * w + rnd() * 2));
  reg.set("sessions_open", Math.round(60 + 25 * w));
  reg.set("api_accounts_active", Math.round(3 + 2 * w));
  for (const k of ["conflict", "duplicate", "lint", "low_confidence", "proposal"]) reg.set("curator_open", Math.round(k === "lint" ? 40 : 8 + rnd() * 3), { kind: k });
  // tasks
  reg.set("tasks", poisson(docs * 3 + (night(t) ? 40 : 2)), { name: "ingest", status: "queued" });
  reg.set("tasks", Math.min(4, docs), { name: "ingest", status: "running" });
  reg.set("tasks", 3, { name: "ingest", status: "failed" });
  reg.set("tasks", night(t) ? 1 : 0, { name: "dream", status: "running" });
  reg.set("tasks_oldest_queued_seconds", docs ? lognormal(20) : 0);
  // memory and sources (slow gauges)
  state.pages += rnd() < 0.3 * w ? 1 : 0;
  reg.set("pages_total", state.pages);
  reg.set("sources_bytes", state.bytes);
  reg.set("chunks_total", state.docs * 31);
  reg.set("imports_running", night(t) ? 1 : 0);
  for (const [s, f] of [["compiled", 0.55], ["embedded", 0.3], ["indexed", 0.1], ["parsed", 0.01], ["stored", 0.01], ["failed", 0.02], ["unsupported", 0.01]] as const) reg.set("sources", Math.round(state.docs * f), { status: s });
  for (const scope of [...SPACES, "celle"]) for (const [l, f] of [["I0", 0.03], ["I1", 0.12], ["I2", 0.3], ["I3", 0.55]] as const) reg.set("sources_by_level", Math.round((state.docs / 4) * f), { scope, level: l });
  if (t.getMinutes() % 15 === 0) {
    state.broken += Math.round((rnd() - 0.55) * 4);
    state.orphans += Math.round((rnd() - 0.5) * 6);
    reg.set("memory_links_unresolved", Math.max(0, state.broken));
    reg.set("memory_links", state.pages * 4.2);
    reg.set("memory_orphans", Math.max(0, state.orphans));
    reg.set("memory_pages_cited_ratio", 0.82 + rnd() * 0.02);
    reg.set("memory_pages_stale", 1200 + Math.round(rnd() * 20));
    reg.set("memory_claims_in_conflict", 14 + Math.round(rnd() * 4));
    reg.set("memory_graph_density", 4.2 + rnd() * 0.05);
    VAULTS.forEach((v, i) => {
      reg.set("db_partition_bytes", (8e9 / (i + 1.4)) * (1 + rnd() * 0.01), { vault: v });
      reg.set("db_partition_dead_ratio", rnd() * 0.08, { vault: v });
    });
  }
  // database and host
  reg.set("db_size_bytes", 31e9 + state.docs * 4000);
  reg.set("db_cache_hit_ratio", 0.985 + rnd() * 0.012);
  reg.set("db_commits_per_min", 200 + 1800 * w + docs * 40);
  reg.set("db_rollbacks_per_min", poisson(1));
  reg.set("db_deadlocks_total", 0);
  reg.set("db_connections", Math.round(6 + 14 * w), { state: "active" });
  reg.set("db_connections", 28, { state: "idle" });
  reg.set("db_connections", poisson(0.5), { state: "idle in transaction" });
  reg.set("host_cpu_percent", Math.min(100, 6 + 45 * w + docs * 6 + (night(t) ? 25 : 0) + rnd() * 6));
  reg.set("host_load1", 0.5 + 6 * w + rnd());
  reg.set("host_mem_total_bytes", 64 * 1024 ** 3);
  reg.set("host_mem_used_bytes", (22 + 9 * w + rnd()) * 1024 ** 3);
  reg.set("process_rss_bytes", (1.4 + 0.5 * w) * 1024 ** 3);
  reg.set("host_net_bytes_per_sec", 2e6 * w + 1e5 + rnd() * 1e5, { dir: "rx" });
  reg.set("host_net_bytes_per_sec", 1.2e6 * w + 8e4 + rnd() * 1e5, { dir: "tx" });
  state.disk += docs * 600_000;
  reg.set("host_disk_used_bytes", state.disk, { path: "data" });
  reg.set("host_disk_total_bytes", 1e12, { path: "data" });
}

// ---------------------------------------------------------------------------
// 1. Write
// ---------------------------------------------------------------------------
const MIN = 60_000;
const end = Math.floor(Date.now() / MIN) * MIN;
const start = end - DAYS * 86_400_000;
const report: Record<string, unknown> = { db: DB, days: DAYS };

if (!SKIP_WRITE) {
  // rerunnable: the range starts empty (the other rows of the database stay)
  await sql`delete from metrics_1m where bucket >= ${new Date(start)} and bucket < ${new Date(end)}`.catch(() => {});
  await sql`delete from metrics_1h where bucket >= ${new Date(start - 3600_000)}`;
  await sql`delete from metrics_1d where bucket >= ${new Date(start - 86_400_000)}`;
  const reg = new MetricsRegistry();
  const t0 = performance.now();
  let rows = 0;
  for (let t = start; t < end; t += MIN) {
    minute(reg, new Date(t));
    rows += await store.write(new Date(t), reg.drain());
    if ((t - start) % (86_400_000) === 0) process.stdout.write(`  giorno ${Math.round((t - start) / 86_400_000) + 1}/${DAYS}\r`);
  }
  const writeS = (performance.now() - t0) / 1000;
  const t1 = performance.now();
  // rollups: a day at a time, like the leader would have done every hour
  for (let d = start - (start % 86_400_000); d < end; d += 86_400_000) await store.rollup("1h", new Date(d), new Date(d + 86_400_000));
  const hourS = (performance.now() - t1) / 1000;
  const t2 = performance.now();
  await store.rollup("1d", new Date(start - (start % 86_400_000)), new Date(end + 86_400_000));
  const dayS = (performance.now() - t2) / 1000;
  await sql`analyze metrics_1m`;
  await sql`analyze metrics_1h`;
  await sql`analyze metrics_1d`;
  const [c] = await sql<{ series: number; m: number; h: number; d: number; bytes: number }[]>`
    select (select count(*)::int from metric_series) as series,
           (select count(*)::int from metrics_1m) as m, (select count(*)::int from metrics_1h) as h, (select count(*)::int from metrics_1d) as d,
           (select sum(pg_total_relation_size(c.oid))::float8 from pg_class c where c.relname like 'metrics_1%' and c.relkind in ('r', 'p')) as bytes`;
  report.write = { rows, seconds: +writeS.toFixed(1), rowsPerSec: Math.round(rows / writeS), rollup1hSeconds: +hourS.toFixed(1), rollup1dSeconds: +dayS.toFixed(1), ...c };
  console.log("\nscrittura", report.write);
}

// ---------------------------------------------------------------------------
// 2. Dashboard queries, like the route: all queries of a dashboard in parallel
// ---------------------------------------------------------------------------
const RANGES = { "1h": 3600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const results: { dashboard: string; range: string; queries: number; medianMs: number; p95Ms: number; table: string; points: number }[] = [];
for (const d of DASHBOARDS) {
  const qs = d.panels.flatMap((p) => (p.kind === "timeseries" ? p.queries : p.kind === "bars" ? [p.q] : p.kind === "stat" && p.q ? [p.q] : []));
  const bound = qs.map((q) => ({ ...q, match: q.match ? Object.fromEntries(Object.entries(q.match).filter(([, v]) => !v.startsWith("$"))) : undefined }));
  for (const [r, ms] of Object.entries(RANGES)) {
    const to = new Date(end);
    const from = new Date(end - ms);
    const times: number[] = [];
    let table = "";
    let points = 0;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const out = await Promise.all(bound.map((q) => store.query({ name: q.name, agg: q.agg, ...(q.match ? { match: q.match } : {}), ...(q.groupBy ? { groupBy: q.groupBy } : {}), from, to, points: 300 })));
      if (i) times.push(performance.now() - t0); // the first run warms the caches
      table = out[0]?.table ?? "";
      points = out.reduce((s, o) => s + o.series.reduce((a, x) => a + x.points.length, 0), 0);
    }
    times.sort((a, b) => a - b);
    results.push({ dashboard: d.id, range: r, queries: bound.length, medianMs: Math.round(times[2]!), p95Ms: Math.round(times.at(-1)!), table, points });
  }
}
console.table(results);
report.queries = results;
const worst = Math.max(...results.map((r) => r.medianMs));
report.worstMedianMs = worst;
mkdirSync("bench/out", { recursive: true });
writeFileSync(`bench/out/phase7-metrics-${DB}.json`, JSON.stringify(report, null, 2));
console.log(`peggior mediana: ${worst} ms · rapporto in bench/out/phase7-metrics-${DB}.json`);
await sql.end();
