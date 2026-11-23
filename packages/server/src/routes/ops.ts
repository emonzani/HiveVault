/**
 * Operations API of the console (plan §8.3, §8.4): metrics for the dashboards, tables for the
 * panels, Prometheus `/metrics`, tasks, sources, models, settings, vault backup and restore.
 * Everything here is for administrators (`admin.ops`); every change is audited at once.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import JSZip from "jszip";
import { AuthError, type AuthService } from "@cb/auth";
import type { BlobStore } from "@cb/blobs";
import { CheckpointStore, CLASSIFICATIONS, exportVault, importVault, isMassChange, PageStore, PERSONAL, serializeDocument } from "@cb/brain";
import type { Sql } from "@cb/db";
import { mergePages, MergeVisibilityError } from "@cb/hive";
import { gpuSnapshot, hostSnapshot, type Agg, type MetricsService } from "@cb/metrics";
import { metrics as registry } from "@cb/shared";
import type { TaskEngine } from "@cb/tasks";
import { meta, requireAction, requireAuth, sameSecret } from "../http.ts";
import { ModelsAdmin, ModelsAdminError } from "../ops/models.ts";
import type { Settings, SettingsShape } from "../ops/settings.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max }) as const;

export interface OpsDeps {
  sql: Sql;
  auth: AuthService;
  metrics: MetricsService;
  engine?: TaskEngine;
  pages: PageStore;
  models?: ModelsAdmin;
  settings: Settings;
  dataDir: string;
  /** The raw store: a deleted source deletes its unused blobs through it. */
  blobs: BlobStore;
  /** Prometheus scrapers: `Authorization: Bearer <token>` (empty = administrators only). */
  metricsToken?: string;
  /** The compilation queue with its estimated wait (M14). */
  queue?: () => Promise<unknown>;
}

/** Constant-time comparison of two secrets (hashes first, so lengths do not leak). */

/** Limits of a vault import: an archive that expands far beyond its size is refused (zip bomb). */
export const IMPORT_LIMITS = { files: 50_000, fileBytes: 50 * 1024 ** 2, totalBytes: 2 * 1024 ** 3 };

export function opsRoutes(app: FastifyInstance, d: OpsDeps): void {
  const { sql, auth } = d;
  const audit = (req: FastifyRequest, action: string, resource: string | null, data?: Record<string, unknown>) =>
    auth.audit.writeNow({ principalId: req.auth?.principal.id ?? null, action, resource, ...meta(req), data: data ?? null });
  const admin = (req: FastifyRequest) => requireAction(req, "admin.ops");
  const checkpoints = new CheckpointStore(sql, d.pages);
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ModelsAdminError) throw new AuthError("invalid_request", e.message);
      throw e;
    }
  };

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------
  app.get("/api/admin/metrics/catalog", async (req) => {
    admin(req);
    return d.metrics.store.catalog();
  });

  const AGGS: Agg[] = ["rate", "sum", "avg", "max", "min", "last", "count", "p50", "p95", "p99"];
  app.post<{ Body: { from: string; to: string; points?: number; queries: { id: string; name: string; agg: Agg; match?: Record<string, string>; groupBy?: string[] }[] } }>(
    "/api/admin/metrics/query",
    {
      schema: {
        body: {
          type: "object",
          required: ["from", "to", "queries"],
          properties: {
            from: { type: "string", format: "date-time" },
            to: { type: "string", format: "date-time" },
            points: int(10, 2000),
            queries: {
              type: "array",
              maxItems: 40,
              items: {
                type: "object",
                required: ["id", "name", "agg"],
                properties: {
                  id: str(60),
                  name: str(120),
                  agg: { enum: AGGS },
                  match: { type: "object", additionalProperties: { type: "string", maxLength: 200 } },
                  groupBy: { type: "array", maxItems: 4, items: str(40) },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      admin(req);
      const from = new Date(req.body.from);
      const to = new Date(req.body.to);
      if (!(to > from)) throw new AuthError("invalid_request", "Intervallo di tempo non valido.");
      const t0 = performance.now();
      const results = await Promise.all(
        req.body.queries.map(async (q) => ({ id: q.id, ...(await d.metrics.store.query({ ...q, from, to, ...(req.body.points ? { points: req.body.points } : {}) })) })),
      );
      return { tookMs: Math.round(performance.now() - t0), results };
    },
  );

  /** Prometheus text format: cumulative counters and histograms of this process, gauges. */
  app.get("/metrics", async (req, reply) => {
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
    if (!(d.metricsToken && sameSecret(bearer, d.metricsToken))) {
      if (!req.auth) throw new AuthError("unauthenticated", "Accesso richiesto.");
      admin(req);
    }
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").header("cache-control", "no-store");
    return registry.prometheus();
  });

  /** Tables and single values of the panels that are not time series. */
  const STATS: Record<string, () => Promise<unknown>> = {
    // The statements that weigh most (mean x calls). Backup (pgBackRest: pg_backup_start waits
    // for a checkpoint) and maintenance are rare and slow by nature: marked, and listed after
    // the queries of the application.
    "slow-queries": async () => {
      try {
        return await sql`
          select kind, query, calls, "meanMs", "totalS", rows from (
            select case
                     when query ~* 'pg_backup_(start|stop)|pg_switch_wal|pg_walfile_name|pg_create_restore_point' then 'backup'
                     when query ~* '^\\s*(vacuum|analyze|reindex|cluster|create (unique )?index|refresh materialized)' then 'manutenzione'
                     else 'applicazione' end as kind,
                   left(regexp_replace(query, '\\s+', ' ', 'g'), 220) as query, calls::int as calls,
                   round(mean_exec_time::numeric, 1)::float8 as "meanMs", round(total_exec_time::numeric / 1000, 1)::float8 as "totalS",
                   rows::int as rows, total_exec_time as total
            from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())) q
          order by kind <> 'applicazione', total desc limit 15`;
      } catch {
        return [];
      }
    },
    partitions: () => sql`
      select v.slug, v.name, v.kind, pg_total_relation_size(c.oid)::float8 as bytes, coalesce(st.n_live_tup, 0)::float8 as live,
             coalesce(st.n_dead_tup, 0)::float8 as dead, st.last_autovacuum as "lastVacuum",
             (select coalesce(sum(pg_relation_size(i.indexrelid)), 0)::float8 from pg_index i
               where i.indrelid = c.oid and pg_get_indexdef(i.indexrelid) like '%hnsw%') as "vectorIndexBytes"
      from vaults v join pg_class c on c.relname = v.chunks_partition left join pg_stat_user_tables st on st.relid = c.oid
      order by 4 desc limit 30`,
    coverage: () => sql`
      select v.slug, v.name, v.kind, count(*) filter (where s.level = 0)::int as "i0", count(*) filter (where s.level = 1)::int as "i1",
             count(*) filter (where s.level = 2)::int as "i2", count(*) filter (where s.level = 3)::int as "i3", count(*)::int as total
      from vaults v left join sources s on s.vault_id = v.id and s.parent_id is null
      group by v.id order by total desc limit 50`,
    "ingest-errors": () => sql`
      select coalesce(split_part(parser_version, '@', 1), mime) as parser, status, left(coalesce(error, ''), 120) as error, count(*)::int as n
      from sources where status in ('failed', 'unsupported') group by 1, 2, 3 order by n desc limit 20`,
    backlog: async () => {
      const [r] = await sql<{ queued: number; rate: number }[]>`
        select (select count(*)::int from tasks where name = 'ingest' and status in ('queued', 'running')) as queued,
               (select count(*)::float8 / 60 from tasks where name = 'ingest' and status = 'done' and finished_at > now() - interval '1 hour') as rate`;
      return { queued: r!.queued, perMinute: r!.rate, etaMinutes: r!.rate > 0 ? Math.round(r!.queued / r!.rate) : null };
    },
    // M14: sources waiting for the chat model, the backlog of the imports, the estimated wait
    "compile-queue": async () => (d.queue ? d.queue() : null),
    "top-pages": () => sql`
      select p.id, p.title, v.slug as vault, count(*)::int as reads, count(distinct l.principal_id)::int as readers
      from audit_log l join pages p on p.id = l.resource join vaults v on v.id = p.vault_id
      where l.action = 'page.read' and l.at > now() - interval '7 days' and p.classification <> ${PERSONAL}
      group by p.id, v.slug order by reads desc limit 15`,
    dream: () => sql`
      select v.slug, v.name, v.kind, to_char(r.night, 'YYYY-MM-DD') as night, r.status, r.step, r.tokens, r.started_at as "startedAt", r.finished_at as "finishedAt",
             (select sum((x.value->>'ms')::float8) from jsonb_each(r.report) x where x.value ? 'ms')::float8 as ms
      from dream_runs r join vaults v on v.id = r.vault_id order by r.night desc, v.kind, v.slug limit 60`,
    "dream-steps": () => sql`
      select x.key as step, round(avg((x.value->>'ms')::float8))::int as "avgMs", max((x.value->>'ms')::float8)::int as "maxMs", count(*)::int as runs
      from dream_runs r, jsonb_each(r.report) x where x.value ? 'ms' and r.night > current_date - 14 group by 1 order by 2 desc`,
    hive: () => sql`
      select v.slug, v.name,
             (select count(*)::int from pages p where p.vault_id = v.id and p.frontmatter ? 'hive_subject') as pages,
             (select count(*)::int from curator_items c where c.space_id = v.id and c.status = 'open' and c.kind = 'conflict') as "openConflicts",
             (select count(*)::int from curator_items c where c.space_id = v.id and c.status = 'resolved') as resolved,
             (select count(*)::int from curator_items c where c.space_id = v.id and c.status in ('dismissed', 'superseded')) as dismissed,
             (select count(*)::int from hive_feeds f where f.space_id = v.id) as cells
      from vaults v where v.kind = 'space' order by pages desc`,
    "hive-cells": () => sql`
      select v.slug as cell, v.name, count(c.*)::int as claims, count(distinct c.page_id)::int as pages
      from hive_feeds f join vaults v on v.id = f.cell_id left join claims c on c.vault_id = f.cell_id and c.status = 'active'
      group by v.id order by claims desc limit 30`,
    "memory-lists": async () => ({
      broken: await sql`
        select p.title, v.slug as vault, l.target_raw as target from links l join pages p on p.id = l.src_page join vaults v on v.id = l.vault_id
        where l.dst_page is null and p.classification <> ${PERSONAL} and not exists (select 1 from aliases a where a.alias_norm = l.target_norm) limit 15`,
      stale: await sql`
        select title, id, to_char(updated_at, 'YYYY-MM-DD') as updated from pages
        where updated_at < now() - interval '180 days' and classification <> ${PERSONAL} order by updated_at limit 15`,
    }),
    security: async () => ({
      failures: await sql`
        select l.at, l.action, coalesce(p.name, l.data->>'username', '—') as who, host(l.ip) as ip from audit_log l left join principals p on p.id = l.principal_id
        where l.outcome <> 'ok' and l.at > now() - interval '7 days' order by l.at desc limit 20`,
      blocked: await sql`select resource as host, count(*)::int as n, max(at) as last from audit_log where action = 'egress.blocked' and at > now() - interval '7 days' group by 1 order by n desc limit 15`,
      apiAccounts: await sql`
        select name, display_name as "displayName", clearance, scopes, last_seen_at as "lastSeen" from principals
        where kind = 'api' and status = 'active' order by last_seen_at desc nulls last limit 20`,
    }),
    /** The machine of this server process, as label/value rows (Host dashboard). */
    host: async () => {
      const h = hostSnapshot(d.dataDir);
      const g = await gpuSnapshot();
      const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
      const days = Math.floor(h.uptime / 86400);
      const hours = Math.floor((h.uptime % 86400) / 3600);
      const info: { voce: string; valore: string }[] = [
        { voce: "Nome", valore: h.hostname },
        { voce: "Sistema", valore: h.platform },
        { voce: "CPU", valore: `${h.cpuModel} × ${h.cores}` },
        { voce: "Memoria", valore: gib(h.memTotal) },
        { voce: "GPU", valore: g ? `${g.name}${g.vramTotal ? ` · ${gib(g.vramTotal)} di VRAM` : ""}` : "nessuna GPU rilevata" },
        { voce: "Disco dati", valore: h.disk ? `${gib(h.disk.total - h.disk.used)} liberi su ${gib(h.disk.total)}` : "—" },
        { voce: "Acceso da", valore: days ? `${days} giorni e ${hours} ore` : `${hours} ore` },
      ];
      return { info };
    },
    overview: async () => {
      const [r] = await sql<Record<string, number>[]>`
        select (select count(*)::int from sources where parent_id is null) as documents, (select coalesce(sum(size), 0)::float8 from sources) as bytes,
               (select count(*)::int from pages) as pages, (select count(*)::int from vaults) as vaults,
               (select count(*)::int from principals where kind = 'user' and status = 'active') as users,
               (select count(*)::int from principals where kind = 'api' and status = 'active') as "apiAccounts",
               pg_database_size(current_database())::float8 as "dbBytes"`;
      return r;
    },
  };
  app.get<{ Params: { name: string } }>("/api/admin/stats/:name", async (req) => {
    admin(req);
    const fn = STATS[req.params.name];
    if (!fn) throw new AuthError("not_found", "Statistica sconosciuta.");
    return fn();
  });

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { status?: string; name?: string; q?: string; limit?: number; offset?: number } }>(
    "/api/admin/tasks",
    { schema: { querystring: { type: "object", properties: { status: str(20), name: str(60), q: str(100), limit: int(1, 500), offset: int(0, 1_000_000) } } } },
    async (req) => {
      admin(req);
      const { status, name, q } = req.query;
      const where = sql`
        where (${status ?? null}::text is null or status = ${status ?? null})
          and (${name ?? null}::text is null or name = ${name ?? null})
          and (${q ?? null}::text is null or id = ${q ?? null} or request_id ilike ${`%${q ?? ""}%`} or error ilike ${`%${q ?? ""}%`})`;
      const items = await sql`
        select id, name, status, phase, attempts, max_attempts as "maxAttempts", priority, error, request_id as "requestId", parent_id as "parentId",
               run_after as "runAfter", created_at as "createdAt", updated_at as "updatedAt", finished_at as "finishedAt", lease_owner as "worker"
        from tasks ${where} order by updated_at desc limit ${req.query.limit ?? 100} offset ${req.query.offset ?? 0}`;
      const counts = await sql<{ status: string; n: number }[]>`select status, count(*)::int as n from tasks group by 1`;
      const names = await sql<{ name: string }[]>`select distinct name from tasks order by 1`;
      return { items, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), names: names.map((n) => n.name) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/tasks/:id", async (req) => {
    admin(req);
    const [t] = await sql`select id, name, status, phase, attempts, error, input, state, result, priority, run_after as "runAfter", request_id as "requestId", created_at as "createdAt", finished_at as "finishedAt" from tasks where id = ${req.params.id}`;
    if (!t) throw new AuthError("not_found", "Task non trovato.");
    const events = await sql`select at, kind, phase, data from task_events where task_id = ${req.params.id} order by id desc limit 100`;
    return { task: t, events };
  });

  app.post<{ Params: { id: string } }>("/api/admin/tasks/:id/retry", async (req) => {
    admin(req);
    const r = await sql`
      update tasks set status = 'queued', attempts = 0, error = null, run_after = now(), finished_at = null, updated_at = now(), lease_owner = null, lease_until = null
      where id = ${req.params.id} and status in ('failed', 'cancelled')`;
    if (!r.count) throw new AuthError("conflict", "Solo un task fallito o annullato si può riprovare.");
    await audit(req, "admin.task.retry", req.params.id);
    return { ok: true };
  });

  /** Priority (0 first) and "run now" of a task that has not run yet or waits. */
  app.patch<{ Params: { id: string }; Body: { priority?: number; runNow?: boolean } }>(
    "/api/admin/tasks/:id",
    { schema: { body: { type: "object", minProperties: 1, properties: { priority: int(0, 9), runNow: { const: true } }, additionalProperties: false } } },
    async (req) => {
      admin(req);
      const { priority, runNow } = req.body;
      const r = await sql`
        update tasks set priority = coalesce(${priority ?? null}::int, priority),
               run_after = case when ${runNow ?? false} then least(run_after, now()) else run_after end, updated_at = now()
        where id = ${req.params.id} and status in ('queued', 'sleeping', 'waiting')`;
      if (!r.count) throw new AuthError("conflict", "Si modificano solo i task in coda o in attesa.");
      await audit(req, "admin.task.update", req.params.id, { ...req.body });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/api/admin/tasks/:id/cancel", async (req) => {
    admin(req);
    if (!d.engine || !(await d.engine.cancel(req.params.id))) throw new AuthError("conflict", "Il task è già concluso.");
    await audit(req, "admin.task.cancel", req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Sources (all vaults) and deletion
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { vault?: string; status?: string; q?: string; limit?: number; offset?: number } }>(
    "/api/admin/sources",
    { schema: { querystring: { type: "object", properties: { vault: str(64), status: str(20), q: str(200), limit: int(1, 500), offset: int(0, 10_000_000) } } } },
    async (req) => {
      admin(req);
      const { vault, status, q } = req.query;
      const items = await sql`
        select s.id, s.vault_id as "vaultId", v.slug as vault, s.name, s.title, s.mime, s.size, s.status, s.level, s.origin, s.classification,
               s.error, s.parent_id as "parentId", s.compiled_page as "compiledPage", s.created_at as "createdAt", s.updated_at as "updatedAt",
               (select count(*)::int from sources k where k.parent_id = s.id) as children
        from sources s join vaults v on v.id = s.vault_id
        where s.classification <> ${PERSONAL} -- personal documents: their owner only
          and (${vault ?? null}::text is null or v.id = ${vault ?? null} or v.slug = ${vault ?? null})
          and (${status ?? null}::text is null or s.status = ${status ?? null})
          and (${q ?? null}::text is null or s.name ilike ${`%${q ?? ""}%`} or s.title ilike ${`%${q ?? ""}%`} or s.id = ${q ?? null})
        order by s.created_at desc limit ${req.query.limit ?? 100} offset ${req.query.offset ?? 0}`;
      return items;
    },
  );

  /**
   * Deletes a source with its children, chunks and tasks. Encrypted blobs no other source of
   * the vault uses are deleted too. Compiled pages stay (their citations become unknown).
   */
  /**
   * Title and classification of a source. The classification goes to the files inside it and
   * to their chunks (search and RLS read the chunks); a compiled page is raised when the source
   * becomes more restricted, never lowered (its text stays as it was written).
   */
  app.patch<{ Params: { id: string }; Body: { title?: string | null; classification?: number } }>(
    "/api/admin/sources/:id",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          properties: { title: { anyOf: [{ type: "string", maxLength: 300 }, { type: "null" }] }, classification: int(0, 3) },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const a = admin(req);
      const [src] = await sql<{ id: string; vaultId: string; title: string | null; classification: number }[]>`
        select id, vault_id as "vaultId", title, classification from sources where id = ${req.params.id} and classification <> ${PERSONAL}`;
      if (!src) throw new AuthError("not_found", "Sorgente non trovata.");
      const { title, classification } = req.body;
      const changes: Record<string, unknown> = {};
      let raised: string[] = [];
      await sql.begin(async (tx) => {
        if (title !== undefined) {
          const t = title?.trim() || null;
          await tx`update sources set title = ${t}, updated_at = now() where id = ${src.id}`;
          changes.title = { from: src.title, to: t };
        }
        if (classification !== undefined && classification !== src.classification) {
          const tree = await tx<{ id: string; page: string | null }[]>`
            with recursive t as (select id from sources where id = ${src.id} union all select s.id from sources s join t on s.parent_id = t.id)
            select s.id, s.compiled_page as page from sources s join t using (id)`;
          const ids = tree.map((r) => r.id);
          await tx`update sources set classification = ${classification}, updated_at = now() where id = any(${ids})`;
          await tx`update chunks set classification = ${classification} where vault_id = ${src.vaultId} and source_id = any(${ids})`;
          await tx`update vaults set version = version + 1 where id = ${src.vaultId}`; // drops cached searches
          raised = [...new Set(tree.map((r) => r.page).filter((p): p is string => !!p))];
          changes.classification = { from: src.classification, to: classification, sources: ids.length };
        }
      });
      // compiled pages: raised to the new level when it is higher (a new page version)
      const pagesRaised: string[] = [];
      if (classification !== undefined) {
        for (const id of raised) {
          const [p] = await sql<{ vaultId: string; classification: number; frontmatter: Record<string, unknown>; body: string }[]>`
            select vault_id as "vaultId", classification, frontmatter, body from pages where id = ${id}`;
          if (!p || p.classification >= classification || p.classification === PERSONAL) continue;
          await d.pages.upsert({ vaultId: p.vaultId, id, markdown: serializeDocument({ ...p.frontmatter, id, classification: CLASSIFICATIONS[classification] }, p.body), author: a.principal.id });
          pagesRaised.push(id);
        }
        if (pagesRaised.length) changes.pagesRaised = pagesRaised;
      }
      if (Object.keys(changes).length) await audit(req, "admin.source.update", src.id, changes);
      return { ok: true, ...changes };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/sources/:id", async (req) => {
    admin(req);
    const tree = await sql<{ id: string; vaultId: string; sha256: string; extracted: string | null; name: string }[]>`
      with recursive t as (select id from sources where id = ${req.params.id} and classification <> ${PERSONAL} union all select s.id from sources s join t on s.parent_id = t.id)
      select s.id, s.vault_id as "vaultId", s.sha256, s.extracted_sha as extracted, s.name from sources s join t using (id)`;
    if (!tree.length) throw new AuthError("not_found", "Sorgente non trovata.");
    const ids = tree.map((t) => t.id);
    const vaultId = tree[0]!.vaultId;
    await sql.begin(async (tx) => {
      await tx`delete from chunks where vault_id = ${vaultId} and source_id = any(${ids})`;
      await tx`update tasks set status = 'cancelled', finished_at = now() where name = 'ingest' and status not in ('done', 'failed', 'cancelled') and input->>'sourceId' = any(${ids})`;
      await tx`delete from sources where id = any(${ids})`;
      await tx`update vaults set version = version + 1 where id = ${vaultId}`;
    });
    const blobs = [...new Set(tree.flatMap((t) => [t.sha256, t.extracted].filter((x): x is string => !!x)))];
    const used = new Set(
      (await sql<{ sha: string }[]>`select sha256 as sha from sources where vault_id = ${vaultId} and sha256 = any(${blobs})
        union select extracted_sha from sources where vault_id = ${vaultId} and extracted_sha = any(${blobs})`).map((r) => r.sha),
    );
    let removed = 0;
    for (const sha of blobs.filter((b) => !used.has(b))) {
      try {
        await d.blobs.delete(vaultId, sha);
        removed++;
      } catch {
        /* a blob that cannot be removed stays: the nightly check reports leftovers */
      }
    }
    await audit(req, "admin.source.delete", req.params.id, { vault: vaultId, name: tree[0]!.name, sources: ids.length, blobs: removed });
    return { deleted: ids.length, blobs: removed };
  });

  // ---------------------------------------------------------------------------
  // Pages: merge two pages (any vault)
  // ---------------------------------------------------------------------------
  app.post<{ Body: { keep: string; drop: string } }>(
    "/api/admin/pages/merge",
    { schema: { body: { type: "object", required: ["keep", "drop"], properties: { keep: str(64), drop: str(64) }, additionalProperties: false } } },
    async (req) => {
      const a = admin(req);
      if (req.body.keep === req.body.drop) throw new AuthError("invalid_request", "Scegli due pagine diverse.");
      const [{ n }] = (await sql`select count(*)::int as n from pages where id = any(${[req.body.keep, req.body.drop]}) and classification <> ${PERSONAL}`) as unknown as [{ n: number }];
      if (n < 2) throw new AuthError("invalid_request", "Le pagine devono esistere ed essere nello stesso vault.");
      try {
        const r = await mergePages(sql, d.pages, req.body.keep, req.body.drop, `admin:${a.principal.id}`);
        await audit(req, "admin.page.merge", r.kept, { removed: r.removed });
        return r;
      } catch (e) {
        if (e instanceof MergeVisibilityError) throw new AuthError("invalid_request", e.message);
        throw new AuthError("invalid_request", "Le pagine devono esistere ed essere nello stesso vault.");
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------
  const models = () => {
    if (!d.models) throw new AuthError("invalid_request", "Gestione dei modelli non disponibile in questo processo.");
    return d.models;
  };
  app.get("/api/admin/models", async (req) => {
    admin(req);
    return models().snapshot();
  });
  app.post<{ Params: { kind: "embed" | "rerank"; action: "start" | "stop" | "restart" } }>(
    "/api/admin/models/local/:kind/:action",
    { schema: { params: { type: "object", properties: { kind: { enum: ["embed", "rerank"] }, action: { enum: ["start", "stop", "restart"] } } } } },
    async (req) => {
      admin(req);
      await wrap(() => models().local(req.params.kind, req.params.action));
      await audit(req, `admin.models.local.${req.params.action}`, req.params.kind);
      return models().snapshot();
    },
  );
  app.put<{ Body: SettingsShape["models.local"] }>(
    "/api/admin/models/local",
    {
      schema: {
        body: {
          type: "object",
          required: ["threads", "schedule", "offHours"],
          properties: { threads: int(1, 256), schedule: { enum: ["always", "off-hours", "on-demand"] }, offHours: str(20) },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const a = admin(req);
      await wrap(() => models().setLocal(req.body, a.principal.id));
      await audit(req, "admin.models.local.settings", null, { ...req.body });
      return models().snapshot();
    },
  );
  app.post<{ Body: { kind: "embed" | "rerank" | "chat" | "ocr"; url: string } }>(
    "/api/admin/models/remote",
    { schema: { body: { type: "object", required: ["kind", "url"], properties: { kind: { enum: ["embed", "rerank", "chat", "ocr"] }, url: str(500) }, additionalProperties: false } } },
    async (req) => {
      const a = admin(req);
      const r = await wrap(() => models().addRemote(req.body.kind, req.body.url, a.principal.id));
      await audit(req, "admin.models.remote.add", r.id, { kind: r.kind, url: r.url });
      return r;
    },
  );
  app.patch<{ Params: { id: string }; Body: { url: string } }>(
    "/api/admin/models/remote/:id",
    { schema: { body: { type: "object", required: ["url"], properties: { url: str(500) }, additionalProperties: false } } },
    async (req) => {
      const a = admin(req);
      const r = await wrap(() => models().updateRemote(req.params.id, req.body.url, a.principal.id));
      await audit(req, "admin.models.remote.update", r.id, { url: r.url });
      return r;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/models/remote/:id", async (req) => {
    const a = admin(req);
    await wrap(() => models().removeRemote(req.params.id, a.principal.id));
    await audit(req, "admin.models.remote.remove", req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/admin/models/:id/test", async (req) => {
    admin(req);
    return models().test(req.params.id);
  });

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  app.get("/api/admin/settings", async (req) => {
    admin(req);
    return d.settings.all();
  });
  const SETTING_SCHEMAS: Record<string, object> = {
    dream: {
      type: "object",
      required: ["window", "minutes", "tokens", "compilePerNight", "useModel"],
      properties: { window: { type: "string", pattern: "^\\d{1,2}:\\d{2}-\\d{1,2}:\\d{2}$" }, minutes: int(1, 1440), tokens: int(0, 100_000_000), compilePerNight: int(0, 100_000), useModel: { type: "boolean" } },
      additionalProperties: false,
    },
    notice: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 5000 } }, additionalProperties: false },
    defaults: { type: "object", required: ["classification"], properties: { classification: int(0, 3) }, additionalProperties: false },
    privacy: {
      type: "object",
      required: ["readRetentionDays", "emailIngest"],
      properties: { readRetentionDays: int(1, 400), emailIngest: { type: "boolean" } },
      additionalProperties: false,
    },
  };
  for (const [key, schema] of Object.entries(SETTING_SCHEMAS)) {
    app.put<{ Body: SettingsShape["dream"] }>(`/api/admin/settings/${key}`, { schema: { body: schema } }, async (req) => {
      const a = admin(req);
      // the body schema of each key matches its settings type
      const v = await d.settings.set(key as "dream", req.body, a.principal.id);
      await audit(req, "admin.settings.update", key, { value: req.body });
      return v;
    });
  }

  // ---------------------------------------------------------------------------
  // Backup: state, vault export (zip of the Obsidian folder) and import
  // ---------------------------------------------------------------------------
  app.get("/api/admin/backup", async (req) => {
    admin(req);
    const [db] = await sql<{ db: number; docs: number }[]>`select pg_database_size(current_database())::float8 as db, coalesce(sum(size), 0)::float8 as docs from sources`;
    const dir = path.join(d.dataDir, "exports");
    let exports: { file: string; bytes: number; at: Date }[] = [];
    try {
      exports = await Promise.all((await readdir(dir)).filter((f) => f.endsWith(".zip")).map(async (f) => {
        const s = await stat(path.join(dir, f));
        return { file: f, bytes: s.size, at: s.mtime };
      }));
      exports.sort((a, b) => b.at.getTime() - a.at.getTime());
    } catch {
      /* no export yet */
    }
    const [check] = await sql<{ at: Date; data: unknown }[]>`select at, data from vault_log where kind = 'dream' order by at desc limit 1`;
    return {
      databaseBytes: db!.db,
      documentsBytes: db!.docs,
      exports: exports.slice(0, 30),
      pgbackrest: { configured: false, note: "Backup continuo del database con pgBackRest: fase 8." },
      lastNightlyCheck: check ?? null,
    };
  });

  app.post<{ Params: { id: string } }>("/api/admin/vaults/:id/export", async (req, reply) => {
    admin(req);
    const [v] = await sql<{ id: string; slug: string }[]>`select id, slug from vaults where id = ${req.params.id} or slug = ${req.params.id}`;
    if (!v) throw new AuthError("not_found", "Vault non trovato.");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-export-"));
    try {
      const r = await exportVault(sql, v.id, tmp);
      const zip = new JSZip();
      const walk = async (dir: string, rel = "") => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p, `${rel}${e.name}/`);
          else zip.file(`${rel}${e.name}`, await readFile(p));
        }
      };
      await walk(tmp);
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const file = `${v.slug}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip`;
      await mkdir(path.join(d.dataDir, "exports"), { recursive: true });
      await writeFile(path.join(d.dataDir, "exports", file), buf);
      await audit(req, "admin.vault.export", v.id, { pages: r.pages, bytes: buf.length, file });
      reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${file}"`).header("cache-control", "no-store");
      return reply.send(buf);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  /**
   * Restores pages from an export (zip of Markdown files) into a vault; pages with the same id or
   * path are updated. A checkpoint of the vault is made first. An import that would rewrite more
   * than a fifth of the existing pages needs `?confirm=true` (409 otherwise, with the numbers).
   */
  app.post<{ Params: { id: string }; Querystring: { confirm?: boolean } }>("/api/admin/vaults/:id/import", { schema: { querystring: { type: "object", properties: { confirm: { type: "boolean" } } } } }, async (req) => {
    const a = admin(req);
    const [v] = await sql<{ id: string }[]>`select id from vaults where id = ${req.params.id} or slug = ${req.params.id}`;
    if (!v) throw new AuthError("not_found", "Vault non trovato.");
    if (!req.isMultipart()) throw new AuthError("invalid_request", "Invia il file zip come multipart/form-data.");
    const part = await req.file({ limits: { fileSize: 2 * 1024 ** 3 } });
    if (!part) throw new AuthError("invalid_request", "Nessun file ricevuto.");
    const zip = await JSZip.loadAsync(await part.toBuffer());
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-import-"));
    try {
      let files = 0;
      let total = 0;
      // what the import will rewrite: an export names files by title and keeps the page id in the frontmatter
      const incomingPaths = new Set<string>();
      const incomingIds = new Set<string>();
      const tooBig = () => new AuthError("invalid_request", "Archivio troppo grande una volta decompresso: dividilo in più file.");
      for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir || !name.endsWith(".md")) continue;
        const target = path.resolve(tmp, name);
        if (!target.startsWith(path.resolve(tmp) + path.sep)) continue; // no path traversal
        if (++files > IMPORT_LIMITS.files) throw tooBig();
        // the declared size can lie: count the bytes while they are inflated
        const chunks: Buffer[] = [];
        let size = 0;
        await new Promise<void>((resolve, reject) => {
          const s = entry.nodeStream();
          s.on("data", (c: Buffer) => {
            size += c.length;
            total += c.length;
            if (size > IMPORT_LIMITS.fileBytes || total > IMPORT_LIMITS.totalBytes) {
              (s as unknown as { destroy?: () => void }).destroy?.();
              reject(tooBig());
            } else chunks.push(c);
          });
          s.on("end", () => resolve());
          s.on("error", reject);
        });
        await mkdir(path.dirname(target), { recursive: true });
        const content = Buffer.concat(chunks);
        await writeFile(target, content);
        incomingPaths.add(path.relative(tmp, target).replaceAll("\\", "/"));
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.toString("utf8", 0, Math.min(content.length, 64 * 1024)));
        const id = fm && /^id:\s*["']?([\w-]+)["']?\s*$/m.exec(fm[1]!)?.[1];
        if (id) incomingIds.add(id);
      }
      const existing = await sql<{ id: string; path: string }[]>`select id, path from pages where vault_id = ${v.id} and not (frontmatter ? 'hive_subject') and classification <> ${PERSONAL}`;
      const touched = existing.filter((p) => incomingIds.has(p.id) || incomingPaths.has(p.path)).length;
      if (req.query.confirm !== true && isMassChange(existing.length, touched)) {
        throw new AuthError("conflict", `L'import riscrive ${touched} delle ${existing.length} pagine del vault. Conferma per continuare: prima viene salvato un punto di ripristino.`);
      }
      const checkpoint = existing.length ? await checkpoints.create(v.id, "Prima dell'import", { by: a.principal.id, kind: "auto" }) : null;
      const r = await importVault(sql, d.pages, v.id, tmp, `admin:${a.principal.id}`);
      await audit(req, "admin.vault.import", v.id, { files, ...r, checkpoint: checkpoint?.id ?? null });
      return { files, ...r, checkpoint: checkpoint?.id ?? null };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Checkpoints: copies of the pages of a vault, restored in one step
  // ---------------------------------------------------------------------------
  const vaultOf = async (ref: string) => {
    const [v] = await sql<{ id: string }[]>`select id from vaults where id = ${ref} or slug = ${ref}`;
    if (!v) throw new AuthError("not_found", "Vault non trovato.");
    return v.id;
  };
  const checkpointOf = async (id: string) => {
    const c = await checkpoints.get(id);
    if (!c) throw new AuthError("not_found", "Punto di ripristino non trovato.");
    return c;
  };

  app.get<{ Params: { id: string } }>("/api/admin/vaults/:id/checkpoints", async (req) => {
    admin(req);
    return checkpoints.list(await vaultOf(req.params.id));
  });

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    "/api/admin/vaults/:id/checkpoints",
    { schema: { body: { type: "object", required: ["name"], properties: { name: str(200) }, additionalProperties: false } } },
    async (req) => {
      const a = admin(req);
      const c = await checkpoints.create(await vaultOf(req.params.id), req.body.name.trim(), { by: a.principal.id });
      await audit(req, "admin.checkpoint.create", c.id, { vault: c.vaultId, pages: c.pages });
      return c;
    },
  );

  app.post<{ Params: { cid: string } }>("/api/admin/checkpoints/:cid/restore", async (req) => {
    const a = admin(req);
    const c = await checkpointOf(req.params.cid);
    const r = await checkpoints.restore(c.id, a.principal.id);
    await audit(req, "admin.checkpoint.restore", c.id, { vault: c.vaultId, ...r, skipped: r.skipped.length });
    return r;
  });

  app.delete<{ Params: { cid: string } }>("/api/admin/checkpoints/:cid", async (req, reply) => {
    admin(req);
    const c = await checkpointOf(req.params.cid);
    await checkpoints.delete(c.id);
    await audit(req, "admin.checkpoint.delete", c.id, { vault: c.vaultId, name: c.name });
    return reply.status(204).send();
  });

  /** For any authenticated user: the cloud agent notice text set by the administrators. */
  app.get("/api/notice-text", async (req) => {
    requireAuth(req);
    return { text: d.settings.get("notice").text };
  });
}
