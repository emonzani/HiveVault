/**
 * Bulk import from a folder or a mounted share (plan §4.4), as a durable task:
 *
 *   scan    walk the tree; one row per file in import_files (size + mtime). A file is
 *           "pending" when it is new or changed since the last scan: a rescan reads only them.
 *   store   in batches: read -> encrypted blob (dedup) -> source -> ingest task (background
 *           priority). Rate limit (files/s), time window ("19:00-07:00"), pause and cancel are
 *           checked between batches; every batch is a checkpoint.
 *
 * Safety: the root must be inside one of the allowed import roots (IMPORT_ROOTS), resolved
 * through symlinks — an admin cannot import arbitrary server files (the master key!).
 */
import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "@cb/db";
import { createLogger, newId } from "@cb/shared";
import { defineTask, submitTask, type TaskDefinition, type TaskEngine } from "@cb/tasks";
import type { IngestTask } from "./pipeline.ts";
import type { SourceStore } from "./sources.ts";

const log = createLogger("ingest.import");

export interface ImportJob {
  id: string;
  vaultId: string;
  root: string;
  include: string[];
  exclude: string[];
  classification: number;
  maxFileBytes: number;
  filesPerSec: number | null;
  windowHours: string | null;
  compile: boolean;
  status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
  taskId: string | null;
  stats: ImportStats;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ImportStats {
  scanned?: number;
  pending?: number;
  stored?: number;
  duplicates?: number;
  skipped?: number;
  errors?: number;
  bytes?: number;
  filesPerSec?: number;
  scanSeconds?: number;
  etaSeconds?: number | null;
}

const JOB_COLS = `id, vault_id as "vaultId", root, include, exclude, classification, max_file_bytes as "maxFileBytes",
  files_per_sec as "filesPerSec", window_hours as "windowHours", compile, status, task_id as "taskId", stats, error,
  created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt", started_at as "startedAt", finished_at as "finishedAt"`;

/** Glob to RegExp: `**` any depth, `*` within a segment, `?` one character. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|~\$[^/]*|\.~lock\.[^/]*|\$RECYCLE\.BIN\/.*|System Volume Information\/.*)$/i;

/** "19:00-07:00": is `now` inside? (the window can cross midnight) */
function inWindow(w: string | null, now = new Date()): boolean {
  if (!w) return true;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(w);
  if (!m) return true;
  const s = Number(m[1]) * 60 + Number(m[2]);
  const e = Number(m[3]) * 60 + Number(m[4]);
  const t = now.getHours() * 60 + now.getMinutes();
  return s <= e ? t >= s && t < e : t >= s || t < e;
}
function nextWindowStart(w: string, now = new Date()): Date {
  const m = /^(\d{1,2}):(\d{2})/.exec(w)!;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

export interface ImportDeps {
  sql: Sql;
  store: SourceStore;
  ingestTask: IngestTask;
  /** Allowed import roots (absolute). Empty = imports disabled. */
  roots: string[];
  batch?: number;
  /** Task name (default "import-folder"). */
  name?: string;
  /** Files stored in parallel inside a batch (default 16). */
  concurrency?: number;
}

export type ImportTask = TaskDefinition<{ jobId: string }, { phaseStarted?: number }, { stored: number }>;

export function defineImportTask(d: ImportDeps): ImportTask {
  const batch = d.batch ?? 200;
  const sql = d.sql;
  const job = async (id: string) => (await sql<ImportJob[]>`select ${sql.unsafe(JOB_COLS)} from import_jobs where id = ${id}`)[0];
  const setStats = (id: string, s: ImportStats) => sql`update import_jobs set stats = stats || ${sql.json(s as never)}, updated_at = now() where id = ${id}`;

  return defineTask<{ jobId: string }, { phaseStarted?: number }, { stored: number }>({
    name: d.name ?? "import-folder",
    version: 1,
    firstPhase: "scan",
    maxAttempts: 10,
    initial: () => ({}),
    phases: {
      scan: async (c) => {
        const j = await job(c.task.input.jobId);
        if (!j || j.status === "cancelled") return c.done({ stored: 0 });
        await sql`update import_jobs set status = 'running', started_at = coalesce(started_at, now()), error = null, updated_at = now() where id = ${j.id}`;
        const t0 = Date.now();
        const include = j.include.map(globToRegExp);
        const exclude = j.exclude.map(globToRegExp);
        let scanned = 0;
        let rows: { job_id: string; rel_path: string; size: number; mtime_ms: number; status: string; reason: string | null }[] = [];
        const flush = async () => {
          if (!rows.length) return;
          const r = rows;
          rows = [];
          await sql`
            insert into import_files ${sql(r as never)}
            on conflict (job_id, rel_path) do update set
              status = case
                when import_files.size <> excluded.size or import_files.mtime_ms <> excluded.mtime_ms then excluded.status
                when import_files.status = 'error' then 'pending'   -- a rescan retries errors
                else import_files.status end,
              size = excluded.size, mtime_ms = excluded.mtime_ms, reason = excluded.reason, seen_at = now()`;
          await setStats(j.id, { scanned });
        };
        const stack = [""];
        while (stack.length) {
          c.signal.throwIfAborted();
          const rel = stack.pop()!;
          let dir;
          try {
            dir = await opendir(path.join(j.root, rel));
          } catch (e) {
            log.warn("cannot read folder", { job: j.id, folder: rel, error: String(e) });
            continue;
          }
          for await (const ent of dir) {
            const p = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) {
              if (!JUNK.test(`${p}/x`)) stack.push(p);
              continue;
            }
            if (!ent.isFile()) continue; // no symlinks, devices, sockets
            if (JUNK.test(p) || (include.length && !include.some((r) => r.test(p))) || exclude.some((r) => r.test(p))) continue;
            let st;
            try {
              st = await stat(path.join(j.root, p));
            } catch {
              continue;
            }
            scanned++;
            const tooLarge = st.size > j.maxFileBytes;
            rows.push({ job_id: j.id, rel_path: p, size: st.size, mtime_ms: Math.floor(st.mtimeMs), status: tooLarge ? "skipped" : st.size === 0 ? "skipped" : "pending", reason: tooLarge ? "too_large" : st.size === 0 ? "empty" : null });
            if (rows.length >= 2000) await flush();
          }
        }
        await flush();
        const [{ pending }] = (await sql`select count(*)::int as pending from import_files where job_id = ${j.id} and status = 'pending'`) as unknown as [{ pending: number }];
        await setStats(j.id, { scanned, pending, scanSeconds: Math.round((Date.now() - t0) / 1000) });
        log.info("scan done", { job: j.id, scanned, pending });
        return c.next("store", { phaseStarted: Date.now() });
      },

      store: async (c) => {
        const j = await job(c.task.input.jobId);
        if (!j || j.status === "cancelled") {
          await sql`update import_jobs set finished_at = now(), updated_at = now() where id = ${c.task.input.jobId}`;
          return c.done({ stored: 0 });
        }
        if (j.status === "paused") return c.sleepUntil(new Date(Date.now() + 15_000), "store", c.task.state);
        if (!inWindow(j.windowHours)) return c.sleepUntil(nextWindowStart(j.windowHours!), "store", c.task.state);

        const files = await sql<{ rel_path: string }[]>`
          select rel_path from import_files where job_id = ${j.id} and status = 'pending' order by rel_path limit ${batch}`;
        if (!files.length) {
          const s = await sql<{ status: string; n: number }[]>`select status, count(*)::int as n from import_files where job_id = ${j.id} group by status`;
          const by = Object.fromEntries(s.map((r) => [r.status, r.n]));
          await setStats(j.id, { pending: 0, stored: by.stored ?? 0, skipped: by.skipped ?? 0, errors: by.error ?? 0, etaSeconds: 0 });
          await sql`update import_jobs set status = 'done', finished_at = now(), updated_at = now() where id = ${j.id}`;
          await d.store.log(j.vaultId, "import", `Import completato: ${j.root}`, j.id, by);
          return c.done({ stored: by.stored ?? 0 });
        }
        const t0 = Date.now();
        let stored = 0;
        let duplicates = 0;
        let errors = 0;
        let bytes = 0;
        // Files of a batch are stored in parallel (I/O bound: read, encrypt, write, 4 small
        // queries). With a rate limit the files go one by one, paced.
        const concurrency = j.filesPerSec ? 1 : (d.concurrency ?? 16);
        let next = 0;
        const one = async (f: { rel_path: string }) => {
          c.signal.throwIfAborted();
          const abs = path.join(j.root, f.rel_path);
          try {
            const { source, created } = await d.store.create(createReadStream(abs), {
              vaultId: j.vaultId,
              name: path.basename(f.rel_path),
              origin: "import",
              path: f.rel_path,
              classification: j.classification,
              priority: 2,
              compile: j.compile,
              createdBy: j.createdBy,
              meta: { importJob: j.id },
            });
            if (created) {
              const t = await submitTask(sql, d.ingestTask, { sourceId: source.id }, { requestId: `ingest:${source.id}:${source.sha256}`, priority: 2 });
              await sql`update sources set task_id = ${t.id} where id = ${source.id} and task_id is null`;
            } else duplicates++;
            await sql`update import_files set status = 'stored', sha256 = ${source.sha256}, source_id = ${source.id}, reason = ${created ? null : "duplicate"} where job_id = ${j.id} and rel_path = ${f.rel_path}`;
            stored++;
            bytes += source.size;
          } catch (e) {
            errors++;
            await sql`update import_files set status = 'error', reason = ${String((e as Error).message ?? e).slice(0, 300)} where job_id = ${j.id} and rel_path = ${f.rel_path}`;
          }
          if (j.filesPerSec) {
            const wait = (stored + errors) * (1000 / j.filesPerSec) - (Date.now() - t0);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, files.length) }, async () => {
            while (next < files.length) await one(files[next++]!);
          }),
        );
        const [{ pending }] = (await sql`select count(*)::int as pending from import_files where job_id = ${j.id} and status = 'pending'`) as unknown as [{ pending: number }];
        const elapsed = (Date.now() - (c.task.state.phaseStarted ?? t0)) / 1000;
        const prev = j.stats;
        const totalStored = (prev.stored ?? 0) + stored;
        const rate = elapsed > 0 ? totalStored / elapsed : 0;
        await setStats(j.id, {
          stored: totalStored,
          duplicates: (prev.duplicates ?? 0) + duplicates,
          errors: (prev.errors ?? 0) + errors,
          bytes: (prev.bytes ?? 0) + bytes,
          pending,
          filesPerSec: Math.round(rate * 10) / 10,
          etaSeconds: rate > 0 ? Math.round(pending / rate) : null,
        });
        return c.next("store", c.task.state);
      },
    },
  });
}

export class ImportService {
  constructor(
    private readonly sql: Sql,
    private readonly engine: TaskEngine,
    private readonly task: ImportTask,
    private readonly roots: string[],
  ) {}

  /** Resolves the root through symlinks and checks it is inside an allowed import root. */
  async checkRoot(root: string): Promise<string> {
    if (!this.roots.length) throw new ImportError("Gli import da cartella sono disattivati: imposta IMPORT_ROOTS.");
    let real: string;
    try {
      real = await realpath(path.resolve(root));
    } catch {
      throw new ImportError(`La cartella "${root}" non esiste o non è leggibile.`);
    }
    const allowed = await Promise.all(this.roots.map((r) => realpath(path.resolve(r)).catch(() => null)));
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const ok = allowed.some((a) => a && (norm(real) === norm(a) || norm(real).startsWith(norm(a) + path.sep)));
    if (!ok) throw new ImportError("La cartella è fuori dalle radici di import consentite (IMPORT_ROOTS).");
    if (!(await stat(real)).isDirectory()) throw new ImportError("Il percorso non è una cartella.");
    return real;
  }

  async create(o: { vaultId: string; root: string; include?: string[]; exclude?: string[]; classification?: number; maxFileBytes?: number; filesPerSec?: number | null; windowHours?: string | null; compile?: boolean; createdBy?: string | null }): Promise<ImportJob> {
    const root = await this.checkRoot(o.root);
    if (o.windowHours && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(o.windowHours)) throw new ImportError('Finestra oraria non valida: usa il formato "19:00-07:00".');
    const id = newId("imp");
    const [j] = await this.sql<ImportJob[]>`
      insert into import_jobs (id, vault_id, root, include, exclude, classification, max_file_bytes, files_per_sec, window_hours, compile, created_by)
      values (${id}, ${o.vaultId}, ${root}, ${o.include ?? []}, ${o.exclude ?? []}, ${o.classification ?? 1}, ${o.maxFileBytes ?? 524_288_000},
              ${o.filesPerSec ?? null}, ${o.windowHours ?? null}, ${o.compile ?? false}, ${o.createdBy ?? null})
      returning ${this.sql.unsafe(JOB_COLS)}`;
    const t = await this.engine.submit(this.task, { jobId: id }, { requestId: `import:${id}:0`, priority: 2 });
    await this.sql`update import_jobs set task_id = ${t.id} where id = ${id}`;
    return { ...j!, taskId: t.id };
  }

  /**
   * Changes the settings of a job. The phases read the job row at every step: speed, window,
   * classification and compilation apply at once; include and exclude at the next scan.
   */
  async update(
    id: string,
    o: { include?: string[]; exclude?: string[]; classification?: number; maxFileBytes?: number; filesPerSec?: number | null; windowHours?: string | null; compile?: boolean },
  ): Promise<ImportJob> {
    if (o.windowHours && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(o.windowHours)) throw new ImportError('Finestra oraria non valida: usa il formato "19:00-07:00".');
    const has = (k: keyof typeof o) => k in o;
    const [j] = await this.sql<ImportJob[]>`
      update import_jobs set
        include = case when ${has("include")} then ${o.include ?? []}::text[] else include end,
        exclude = case when ${has("exclude")} then ${o.exclude ?? []}::text[] else exclude end,
        classification = coalesce(${o.classification ?? null}::int, classification),
        max_file_bytes = coalesce(${o.maxFileBytes ?? null}::bigint, max_file_bytes),
        files_per_sec = case when ${has("filesPerSec")} then ${o.filesPerSec ?? null}::float8 else files_per_sec end,
        window_hours = case when ${has("windowHours")} then ${o.windowHours ?? null} else window_hours end,
        compile = coalesce(${o.compile ?? null}::boolean, compile),
        updated_at = now()
      where id = ${id}
      returning ${this.sql.unsafe(JOB_COLS)}`;
    if (!j) throw new ImportError("Import non trovato.");
    return j;
  }

  async get(id: string): Promise<(ImportJob & { ingest: Record<string, number> }) | undefined> {
    const [j] = await this.sql<ImportJob[]>`select ${this.sql.unsafe(JOB_COLS)} from import_jobs where id = ${id}`;
    if (!j) return undefined;
    // progress of the ingestion of the stored files, by level reached
    const lv = await this.sql<{ level: number; n: number }[]>`
      select s.level, count(*)::int as n from import_files f join sources s on s.id = f.source_id
      where f.job_id = ${id} group by s.level`;
    return { ...j, ingest: Object.fromEntries(lv.map((r) => [`I${r.level}`, r.n])) };
  }

  async list(vaultId?: string): Promise<ImportJob[]> {
    return this.sql<ImportJob[]>`
      select ${this.sql.unsafe(JOB_COLS)} from import_jobs where (${vaultId ?? null}::text is null or vault_id = ${vaultId ?? null}) order by created_at desc limit 200`;
  }

  async setStatus(id: string, status: "paused" | "running" | "cancelled"): Promise<void> {
    const r = await this.sql`
      update import_jobs set status = ${status}, updated_at = now()
      where id = ${id} and status in ('queued', 'running', 'paused')`;
    if (!r.count) throw new ImportError("L'import non è in corso.");
  }

  /** Scans again: only new or changed files are read. */
  async rescan(id: string): Promise<string> {
    const j = await this.get(id);
    if (!j) throw new ImportError("Import non trovato.");
    if (j.status === "running" || j.status === "queued") throw new ImportError("L'import è ancora in corso.");
    await this.checkRoot(j.root);
    await this.sql`update import_jobs set status = 'queued', finished_at = null, stats = stats - 'etaSeconds', updated_at = now() where id = ${id}`;
    const t = await this.engine.submit(this.task, { jobId: id }, { requestId: `import:${id}:${Date.now()}`, priority: 2 });
    await this.sql`update import_jobs set task_id = ${t.id} where id = ${id}`;
    return t.id;
  }
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}
