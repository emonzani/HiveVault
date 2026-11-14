import { hostname } from "node:os";
import type { Sql, TransactionSql } from "@cb/db";
import { createLogger, newId, ulid, type Logger, metrics } from "@cb/shared";
import {
  InterruptedEffectError,
  LeaseLostError,
  type ChildSummary,
  type PhaseContext,
  type PhaseOutcome,
  type SpawnOptions,
  type TaskDefinition,
  type TaskRow,
} from "./define.ts";

/**
 * Task engine on Postgres.
 *
 * - Claim: `FOR UPDATE SKIP LOCKED`, so many workers (threads or processes) share the queue
 *   without conflicts. `LISTEN cb_tasks` wakes workers at once; a poll covers sleeping tasks.
 * - Lease: the claiming worker owns the task until `lease_until`; a heartbeat renews it.
 *   Every write of the task checks the lease owner (fencing): a worker that lost its lease
 *   cannot commit a phase or a database effect.
 * - Reaper: expired leases (crashed workers) go back to the queue; the task continues from
 *   the last committed phase.
 * - Attempts count consecutive failures of the current phase; a committed phase resets them.
 */

export type TaskStatus = "queued" | "running" | "sleeping" | "waiting" | "done" | "failed" | "cancelled";

export interface SubmitOptions {
  requestId?: string;
  priority?: number;
  runAfter?: Date;
  parentId?: string;
}

export interface EngineOptions {
  workerId?: string;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
}

export interface TaskInfo {
  id: string;
  name: string;
  status: TaskStatus;
  phase: string;
  result: unknown;
  error: string | null;
  attempts: number;
}

interface DbTask {
  id: string;
  name: string;
  version: number;
  request_id: string | null;
  parent_id: string | null;
  status: TaskStatus;
  phase: string;
  input: unknown;
  state: unknown;
  attempts: number;
  max_attempts: number;
  priority: number;
}

const TERMINAL = ["done", "failed", "cancelled"];

function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 5 * 60 * 1000);
}

export class TaskEngine {
  readonly workerId: string;
  private readonly defs = new Map<string, TaskDefinition<any, any, any>>();
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly log: Logger;
  private running = 0;
  private started = false;
  private stopping = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private reaperTimer: NodeJS.Timeout | undefined;
  private unlisten: (() => Promise<void>) | undefined;
  private readonly inflight = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private claiming = false;
  private claimAgain = false;

  constructor(
    private readonly sql: Sql,
    opts: EngineOptions = {},
  ) {
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}:${ulid().slice(-6)}`;
    this.concurrency = opts.concurrency ?? 4;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 1000;
    this.log = createLogger("tasks").child(this.workerId);
  }

  register(...defs: TaskDefinition<any, any, any>[]): this {
    for (const d of defs) this.defs.set(d.name, d);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Submission and inspection
  // ---------------------------------------------------------------------------

  /** Idempotent: the same requestId returns the existing task (`created: false`). */
  async submit<I>(def: TaskDefinition<I, any, any>, input: I, o: SubmitOptions = {}): Promise<{ id: string; created: boolean }> {
    return submitTask(this.sql, def, input, o);
  }

  async get(id: string): Promise<TaskInfo | undefined> {
    const [r] = await this.sql<TaskInfo[]>`
      select id, name, status, phase, result, error, attempts from tasks where id = ${id}`;
    return r;
  }

  async cancel(id: string): Promise<boolean> {
    const r = await this.sql`
      update tasks set status = 'cancelled', finished_at = now(), updated_at = now(), lease_owner = null, lease_until = null
      where id = ${id} and status not in ('done', 'failed', 'cancelled')`;
    if (r.count) await this.event(this.sql, id, "cancelled", null, null);
    return r.count > 0;
  }

  /** Polls until the task is terminal. For tests, tools and the CLI. */
  async waitFor(id: string, timeoutMs = 60_000): Promise<TaskInfo> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const t = await this.get(id);
      if (t && TERMINAL.includes(t.status)) return t;
      if (Date.now() > end) throw new Error(`Task ${id} not finished after ${timeoutMs} ms (status ${t?.status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ---------------------------------------------------------------------------
  // Worker lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const listener = await this.sql.listen("cb_tasks", () => this.kick());
    this.unlisten = () => listener.unlisten();
    this.pollTimer = setInterval(() => this.kick(), this.pollMs);
    this.reaperTimer = setInterval(() => void this.reap().catch((e) => this.log.error("reaper", { error: String(e) })), Math.max(500, this.leaseMs / 2));
    await this.reap();
    this.kick();
  }

  /**
   * Graceful stop: no new claims, abort running phases, wait for them, release their leases
   * (the tasks go back to the queue and continue from the last committed phase).
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearInterval(this.reaperTimer);
    await this.unlisten?.().catch(() => {});
    for (const c of this.controllers) c.abort(new Error("engine stopping"));
    await Promise.allSettled([...this.inflight]);
    await this.sql`
      update tasks set status = 'queued', lease_owner = null, lease_until = null, updated_at = now()
      where status = 'running' and lease_owner = ${this.workerId}`;
    this.started = false;
  }

  private kick(): void {
    if (!this.started || this.stopping) return;
    if (this.claiming) {
      this.claimAgain = true;
      return;
    }
    this.claiming = true;
    void this.claimLoop()
      .catch((e) => this.log.error("claim", { error: String(e) }))
      .finally(() => {
        this.claiming = false;
        if (this.claimAgain) {
          this.claimAgain = false;
          this.kick();
        }
      });
  }

  private async claimLoop(): Promise<void> {
    while (!this.stopping) {
      const free = this.concurrency - this.running;
      if (free <= 0 || this.defs.size === 0) return;
      const names = [...this.defs.keys()];
      const rows = await this.sql<DbTask[]>`
        update tasks t
           set status = 'running', lease_owner = ${this.workerId},
               lease_until = now() + ${this.leaseMs} * interval '1 millisecond',
               attempts = t.attempts + 1, updated_at = now()
         where t.id in (
           select id from tasks
            where status in ('queued', 'sleeping') and run_after <= now() and name = any(${names})
            order by priority, run_after, id
            limit ${free}
            for update skip locked)
        returning t.id, t.name, t.version, t.request_id, t.parent_id, t.status, t.phase, t.input, t.state,
                  t.attempts, t.max_attempts, t.priority`;
      if (rows.length === 0) return;
      for (const row of rows) {
        this.running++;
        const p = this.runTask(row).finally(() => {
          this.running--;
          this.inflight.delete(p);
          this.kick();
        });
        this.inflight.add(p);
      }
    }
  }

  private async reap(): Promise<void> {
    const rows = await this.sql<{ id: string; status: string }[]>`
      update tasks
         set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
             error = case when attempts >= max_attempts then 'lease expired too many times' else error end,
             finished_at = case when attempts >= max_attempts then now() else null end,
             lease_owner = null, lease_until = null, updated_at = now()
       where status = 'running' and lease_until < now()
      returning id, status`;
    for (const r of rows) {
      await this.event(this.sql, r.id, "lease_expired", null, { now: r.status });
      if (r.status === "failed") await this.wakeParentOf(this.sql, r.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Running phases
  // ---------------------------------------------------------------------------

  private async runTask(row: DbTask): Promise<void> {
    const def = this.defs.get(row.name);
    if (!def) return;
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const heartbeat = setInterval(() => {
      void this.sql`
        update tasks set lease_until = now() + ${this.leaseMs} * interval '1 millisecond'
        where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`
        .then((r) => {
          if (r.count === 0) ctrl.abort(new LeaseLostError(row.id));
        })
        .catch(() => {});
    }, Math.max(200, this.leaseMs / 3));

    let phase = row.phase;
    let state = row.state;
    try {
      await this.event(this.sql, row.id, "claimed", phase, { attempt: row.attempts, worker: this.workerId });
      for (;;) {
        const handler = def.phases[phase];
        if (!handler) throw new Error(`Task ${def.name}: phase "${phase}" is not defined`);
        const task: TaskRow<any, any> = {
          id: row.id,
          name: row.name,
          version: row.version,
          requestId: row.request_id,
          parentId: row.parent_id,
          phase,
          input: row.input,
          state,
          attempts: row.attempts,
          priority: row.priority,
        };
        let outcome: PhaseOutcome<any, any>;
        const t0 = performance.now();
        try {
          outcome = await handler(this.context(task, ctrl.signal));
          metrics.observe("task_phase_ms", performance.now() - t0, { task: row.name, phase });
          metrics.inc("task_phases", { task: row.name, outcome: outcome.type });
        } catch (err) {
          metrics.inc("task_phases", { task: row.name, outcome: "error" });
          if (ctrl.signal.aborted && ctrl.signal.reason instanceof LeaseLostError) throw ctrl.signal.reason;
          if (this.stopping && ctrl.signal.aborted) return; // stop() releases the lease
          await this.recordFailure(row, def, phase, err);
          return;
        }
        const continueWith = await this.commit(row, phase, outcome);
        if (!continueWith) return;
        phase = continueWith.phase;
        state = continueWith.state;
        row.attempts = 0;
        if (ctrl.signal.aborted) return;
      }
    } catch (err) {
      if (err instanceof LeaseLostError) this.log.warn("lease lost", { task: row.id });
      else this.log.error("task crashed", { task: row.id, error: String(err) });
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(ctrl);
    }
  }

  /** Commits the outcome of a phase. Returns the next phase to run now, if any. */
  private async commit(row: DbTask, phase: string, o: PhaseOutcome<any, any>): Promise<{ phase: string; state: unknown } | undefined> {
    return this.sql.begin(async (tx) => {
      let res;
      switch (o.type) {
        case "next":
          res = await tx`
            update tasks set phase = ${o.phase}, state = ${tx.json(o.state)}, attempts = 0, error = null, updated_at = now()
            where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`;
          break;
        case "done":
          res = await tx`
            update tasks set status = 'done', result = ${tx.json(o.result ?? null)}, finished_at = now(), updated_at = now(),
                   lease_owner = null, lease_until = null, error = null
            where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`;
          break;
        case "fail":
          res = await tx`
            update tasks set status = 'failed', error = ${o.error}, finished_at = now(), updated_at = now(),
                   lease_owner = null, lease_until = null
            where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`;
          break;
        case "sleep":
          res = await tx`
            update tasks set status = 'sleeping', phase = ${o.phase}, state = ${tx.json(o.state)}, run_after = ${o.until},
                   attempts = 0, lease_owner = null, lease_until = null, updated_at = now()
            where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`;
          break;
        case "wait":
          res = await tx`
            update tasks set status = 'waiting', phase = ${o.phase}, state = ${tx.json(o.state)},
                   attempts = 0, lease_owner = null, lease_until = null, updated_at = now()
            where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`;
          break;
      }
      if (!res || res.count === 0) throw new LeaseLostError(row.id);
      await this.event(tx, row.id, o.type === "next" ? "phase_done" : o.type, phase, o.type === "fail" ? { error: o.error } : null);

      if (o.type === "wait") {
        // Children that finished before this commit cannot wake us: check now (new snapshot).
        await tx`
          update tasks set status = 'queued', run_after = now(), updated_at = now()
          where id = ${row.id} and status = 'waiting'
            and not exists (select 1 from tasks c where c.parent_id = ${row.id} and c.status not in ('done','failed','cancelled'))`;
      }
      if ((o.type === "done" || o.type === "fail") && row.parent_id) await this.wakeParentOf(tx, row.id, row.parent_id);
      return o.type === "next" ? { phase: o.phase, state: o.state } : undefined;
    });
  }

  private async recordFailure(row: DbTask, def: TaskDefinition<any, any, any>, phase: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const max = def.maxAttempts ?? row.max_attempts;
    const final = row.attempts >= max;
    const delay = (def.backoffMs ?? defaultBackoff)(row.attempts);
    await this.sql.begin(async (tx) => {
      const r = await tx`
        update tasks
           set status = ${final ? "failed" : "queued"}, error = ${message},
               run_after = now() + ${delay} * interval '1 millisecond',
               finished_at = ${final ? new Date() : null},
               lease_owner = null, lease_until = null, updated_at = now()
         where id = ${row.id} and lease_owner = ${this.workerId} and status = 'running'`;
      if (r.count === 0) return;
      await this.event(tx, row.id, final ? "failed" : "retry", phase, { error: message, attempt: row.attempts, delayMs: delay });
      if (final && row.parent_id) await this.wakeParentOf(tx, row.id, row.parent_id);
    });
    this.log.warn(final ? "task failed" : "phase failed, retry", { task: row.id, phase, error: message });
  }

  /** Wakes the parent when all its children are terminal. Locks the parent row first, so
   *  that two siblings finishing at the same time cannot both miss the last one. */
  private async wakeParentOf(sql: Sql | TransactionSql, childId: string, parentId?: string): Promise<void> {
    const pid =
      parentId ?? (await sql<{ parent_id: string | null }[]>`select parent_id from tasks where id = ${childId}`)[0]?.parent_id;
    if (!pid) return;
    await sql`select id from tasks where id = ${pid} for update`;
    await sql`
      update tasks set status = 'queued', run_after = now(), updated_at = now()
      where id = ${pid} and status = 'waiting'
        and not exists (select 1 from tasks c where c.parent_id = ${pid} and c.status not in ('done','failed','cancelled'))`;
  }

  private context(task: TaskRow<any, any>, signal: AbortSignal): PhaseContext<any, any, any> {
    const sql = this.sql;
    const worker = this.workerId;
    return {
      task,
      sql,
      signal,
      log: this.log.child(task.id),

      async effect(key, fn, opts) {
        const [prev] = await sql<{ status: string; result: unknown; replay_safe: boolean }[]>`
          select status, result, replay_safe from task_effects where task_id = ${task.id} and key = ${key}`;
        if (prev?.status === "done") return prev.result as never;
        if (prev && !opts.replaySafe) throw new InterruptedEffectError(key);
        await sql`
          insert into task_effects (task_id, key, replay_safe, status) values (${task.id}, ${key}, ${opts.replaySafe}, 'intent')
          on conflict (task_id, key) do update set started_at = now(), status = 'intent'`;
        try {
          const result = await fn();
          await sql`
            update task_effects set status = 'done', result = ${sql.json((result ?? null) as never)}, finished_at = now()
            where task_id = ${task.id} and key = ${key}`;
          return result;
        } catch (err) {
          // A failed effect did not happen: it can be tried again.
          await sql`delete from task_effects where task_id = ${task.id} and key = ${key}`;
          throw err;
        }
      },

      async effectTx(key, fn) {
        return sql.begin(async (tx) => {
          const [own] = await tx`select 1 from tasks where id = ${task.id} and lease_owner = ${worker} and status = 'running' for update`;
          if (!own) throw new LeaseLostError(task.id);
          const [prev] = await tx<{ result: unknown }[]>`
            select result from task_effects where task_id = ${task.id} and key = ${key} and status = 'done'`;
          if (prev) return prev.result as never;
          const result = await fn(tx);
          await tx`
            insert into task_effects (task_id, key, replay_safe, status, result, finished_at)
            values (${task.id}, ${key}, true, 'done', ${tx.json((result ?? null) as never)}, now())`;
          return result;
        }) as never;
      },

      async spawn(def, key, input, opts: SpawnOptions = {}) {
        const r = await submitTask(sql, def, input, {
          requestId: opts.requestId ?? `${task.id}:${key}`,
          priority: opts.priority ?? task.priority,
          parentId: task.id,
        });
        return r.id;
      },

      async children(): Promise<ChildSummary[]> {
        return sql<ChildSummary[]>`
          select id, name, status, result, error from tasks where parent_id = ${task.id} order by created_at, id`;
      },

      next: (phase, state) => ({ type: "next", phase, state }),
      done: (result) => ({ type: "done", result }),
      sleepUntil: (until, phase, state) => ({ type: "sleep", until, phase, state }),
      waitChildren: (phase, state) => ({ type: "wait", phase, state }),
      fail: (error) => ({ type: "fail", error }),
    };
  }

  private async event(sql: Sql | TransactionSql, taskId: string, kind: string, phase: string | null, data: unknown): Promise<void> {
    await sql`insert into task_events (task_id, kind, phase, data) values (${taskId}, ${kind}, ${phase}, ${data === null ? null : sql.json(data as never)})`;
  }
}

export async function submitTask<I>(
  sql: Sql,
  def: TaskDefinition<I, any, any>,
  input: I,
  o: SubmitOptions = {},
): Promise<{ id: string; created: boolean }> {
  const id = newId("tsk");
  const rows = await sql<{ id: string }[]>`
    insert into tasks (id, name, version, request_id, parent_id, phase, input, state, priority, max_attempts, run_after)
    values (${id}, ${def.name}, ${def.version}, ${o.requestId ?? null}, ${o.parentId ?? null}, ${def.firstPhase},
            ${sql.json(input as never)}, ${sql.json(def.initial(input) as never)}, ${o.priority ?? 1},
            ${def.maxAttempts ?? 5}, ${o.runAfter ?? new Date()})
    on conflict (request_id) do nothing
    returning id`;
  if (rows[0]) {
    await sql`insert into task_events (task_id, kind, phase) values (${id}, 'created', ${def.firstPhase})`;
    return { id, created: true };
  }
  const [existing] = await sql<{ id: string }[]>`select id from tasks where request_id = ${o.requestId!}`;
  return { id: existing!.id, created: false };
}
