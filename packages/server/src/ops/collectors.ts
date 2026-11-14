/**
 * Gauges for the dashboards, sampled by the leader process (plan §8.4). Cheap queries run
 * every minute; the expensive ones (partition sizes, memory health) every 15 minutes.
 * Label values are bounded: task names, statuses, endpoint ids, hive spaces, top partitions.
 */
import type { Sql } from "@cb/db";
import { gpuSnapshot, hostSnapshot, type MetricsService } from "@cb/metrics";
import type { ModelsRuntime } from "@cb/models";

export function registerCollectors(m: MetricsService, d: { sql: Sql; models: ModelsRuntime; dataDir: string }): void {
  const { sql } = d;
  let prevDb: { hit: number; read: number; commits: number; rollbacks: number; t: number } | null = null;

  m.addCollector("host", async (set) => {
    const h = hostSnapshot(d.dataDir);
    if (h.cpuTemp !== null) set("host_cpu_temp_c", h.cpuTemp);
    const g = await gpuSnapshot();
    if (g) {
      const l = { gpu: g.name };
      if (g.use !== null) set("host_gpu_percent", g.use, l);
      if (g.vramUsed !== null) set("host_gpu_vram_used_bytes", g.vramUsed, l);
      if (g.vramTotal !== null) set("host_gpu_vram_total_bytes", g.vramTotal, l);
      if (g.temp !== null) set("host_gpu_temp_c", g.temp, { ...l, sensor: "bordo" });
      if (g.junction !== null) set("host_gpu_temp_c", g.junction, { ...l, sensor: "junction" });
      if (g.power !== null) set("host_gpu_power_w", g.power, l);
    }
    set("host_cpu_percent", h.cpu);
    set("host_mem_used_bytes", h.memUsed);
    set("host_mem_total_bytes", h.memTotal);
    set("host_load1", h.load1);
    set("process_rss_bytes", h.processRss);
    if (h.rxPerSec !== null) set("host_net_bytes_per_sec", h.rxPerSec, { dir: "rx" });
    if (h.txPerSec !== null) set("host_net_bytes_per_sec", h.txPerSec, { dir: "tx" });
    if (h.disk) {
      set("host_disk_used_bytes", h.disk.used, { path: "data" });
      set("host_disk_total_bytes", h.disk.total, { path: "data" });
    }
  });

  m.addCollector("database", async (set) => {
    const [db] = await sql<{ size: number; hit: number; read: number; commits: number; rollbacks: number; deadlocks: number; temp: number }[]>`
      select pg_database_size(current_database())::float8 as size, blks_hit::float8 as hit, blks_read::float8 as read,
             xact_commit::float8 as commits, xact_rollback::float8 as rollbacks, deadlocks::float8 as deadlocks, temp_bytes::float8 as temp
      from pg_stat_database where datname = current_database()`;
    if (db) {
      set("db_size_bytes", db.size);
      set("db_deadlocks_total", db.deadlocks);
      if (prevDb) {
        const dh = db.hit - prevDb.hit;
        const dr = db.read - prevDb.read;
        if (dh + dr > 0) set("db_cache_hit_ratio", dh / (dh + dr));
        const dt = Math.max(1, (Date.now() - prevDb.t) / 60_000);
        set("db_commits_per_min", (db.commits - prevDb.commits) / dt);
        set("db_rollbacks_per_min", (db.rollbacks - prevDb.rollbacks) / dt);
      }
      prevDb = { hit: db.hit, read: db.read, commits: db.commits, rollbacks: db.rollbacks, t: Date.now() };
    }
    for (const r of await sql<{ state: string; n: number }[]>`
      select coalesce(state, 'other') as state, count(*)::int as n from pg_stat_activity where datname = current_database() group by 1`) {
      set("db_connections", r.n, { state: r.state });
    }
  });

  m.addCollector("tasks", async (set) => {
    for (const r of await sql<{ name: string; status: string; n: number }[]>`
      select name, status, count(*)::int as n from tasks
      where status in ('queued', 'running', 'sleeping', 'waiting') or (status = 'failed' and finished_at > now() - interval '24 hours')
      group by 1, 2`) {
      set("tasks", r.n, { name: r.name, status: r.status });
    }
    const [lag] = await sql<{ s: number | null }[]>`select extract(epoch from now() - min(run_after))::float8 as s from tasks where status = 'queued' and run_after <= now()`;
    set("tasks_oldest_queued_seconds", lag?.s ?? 0);
  });

  m.addCollector("sources", async (set) => {
    for (const r of await sql<{ status: string; n: number }[]>`select status, count(*)::int as n from sources group by 1`) set("sources", r.n, { status: r.status });
    // coverage by level for each hive space (by id, like hive_promotions), and for all cells together
    for (const r of await sql<{ scope: string; level: number; n: number }[]>`
      select case when v.kind = 'space' then v.id else 'celle' end as scope, s.level, count(*)::int as n
      from sources s join vaults v on v.id = s.vault_id where s.parent_id is null group by 1, 2`) {
      set("sources_by_level", r.n, { scope: r.scope, level: `I${r.level}` });
    }
    const [b] = await sql<{ bytes: number; pages: number; chunks: number }[]>`
      select (select coalesce(sum(size), 0)::float8 from sources) as bytes, (select count(*)::float8 from pages) as pages,
             (select reltuples::float8 from pg_class where relname = 'chunks') as chunks`;
    set("sources_bytes", b!.bytes);
    set("pages_total", b!.pages);
    const [c] = await sql<{ n: number }[]>`select coalesce(sum(c.reltuples), 0)::float8 as n from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'chunks'::regclass`;
    set("chunks_total", Math.max(0, c!.n));
    const [imp] = await sql<{ n: number }[]>`select count(*)::int as n from import_jobs where status in ('queued', 'running')`;
    set("imports_running", imp?.n ?? 0);
  });

  m.addCollector("models", (set) => {
    const s = d.models.dispatcher.snapshot();
    for (const e of s.endpoints) {
      const l = { endpoint: e.id, kind: e.kind };
      set("model_endpoint_up", e.status === "up" ? 1 : 0, l);
      set("model_endpoint_inflight", e.inflight, l);
      if (e.latencyMs !== null) set("model_endpoint_latency_ms", e.latencyMs, l);
      if (e.itemsPerSec !== null) set("model_endpoint_items_per_sec", e.itemsPerSec, l);
    }
    for (const [kind, q] of Object.entries(s.queues)) for (const [p, n] of Object.entries(q)) set("model_queue", n, { kind, priority: p });
    for (const sup of d.models.supervisors) {
      const x = sup.snapshot();
      set("model_local_running", x.status === "running" ? 1 : 0, { process: x.name });
      set("model_local_restarts", x.restarts, { process: x.name });
    }
  });

  m.addCollector("access", async (set) => {
    const [r] = await sql<{ users: number; sessions: number; api: number }[]>`
      select (select count(distinct principal_id)::int from sessions where revoked_at is null and last_seen_at > now() - interval '5 minutes') as users,
             (select count(*)::int from sessions where revoked_at is null and expires_at > now()) as sessions,
             (select count(*)::int from principals where kind = 'api' and status = 'active' and last_seen_at > now() - interval '1 hour') as api`;
    set("users_active", r!.users);
    set("sessions_open", r!.sessions);
    set("api_accounts_active", r!.api);
    for (const c of await sql<{ kind: string; n: number }[]>`select kind, count(*)::int as n from curator_items where status = 'open' group by 1`) set("curator_open", c.n, { kind: c.kind });
  });

  m.addCollector(
    "partitions",
    async (set) => {
      const rows = await sql<{ slug: string; bytes: number; dead: number; live: number }[]>`
        select v.slug, pg_total_relation_size(c.oid)::float8 as bytes, coalesce(st.n_dead_tup, 0)::float8 as dead, coalesce(st.n_live_tup, 0)::float8 as live
        from vaults v join pg_class c on c.relname = v.chunks_partition left join pg_stat_user_tables st on st.relid = c.oid
        order by 2 desc`;
      let other = 0;
      rows.forEach((r, i) => {
        if (i < 15) {
          set("db_partition_bytes", r.bytes, { vault: r.slug });
          set("db_partition_dead_ratio", r.live + r.dead ? r.dead / (r.live + r.dead) : 0, { vault: r.slug });
        } else other += r.bytes;
      });
      if (rows.length > 15) set("db_partition_bytes", other, { vault: "altri" });
    },
    15 * 60_000,
  );

  m.addCollector(
    "memory-health",
    async (set) => {
      const [h] = await sql<{ unresolved: number; links: number; orphans: number; pages: number; cited: number; stale: number; conflicts: number }[]>`
        select (select count(*)::float8 from links where dst_page is null) as unresolved,
               (select count(*)::float8 from links) as links,
               (select count(*)::float8 from pages p where not exists (select 1 from links l where l.dst_page = p.id)
                  and split_part(p.type, '/', 1) <> 'source' and not (p.frontmatter ? 'hive_subject') and p.path not like '\\_inbox/%') as orphans,
               (select count(*)::float8 from pages) as pages,
               (select count(*)::float8 from pages where body like '%^[%') as cited,
               (select count(*)::float8 from pages where updated_at < now() - interval '180 days') as stale,
               (select count(*)::float8 from claims c1 where status = 'active' and predicate <> '_'
                  and exists (select 1 from claims c2 where c2.status = 'active' and c2.subject_norm = c1.subject_norm and c2.vault_id = c1.vault_id
                                and c2.predicate = c1.predicate and c2.value_norm <> c1.value_norm)) as conflicts`;
      set("memory_links_unresolved", h!.unresolved);
      set("memory_links", h!.links);
      set("memory_orphans", h!.orphans);
      set("memory_pages_cited_ratio", h!.pages ? h!.cited / h!.pages : 0);
      set("memory_pages_stale", h!.stale);
      set("memory_claims_in_conflict", h!.conflicts);
      set("memory_graph_density", h!.pages ? h!.links / h!.pages : 0);
    },
    15 * 60_000,
  );
}
