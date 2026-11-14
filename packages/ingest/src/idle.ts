/**
 * Compilation when the chat model is free (M3). Imports and links are stored and indexed (I2)
 * without a compilation; until now only the dream cycle compiled them, 20 per vault and night.
 *
 * One durable task wakes every `intervalMs`. When a real chat model is up and has nothing to
 * do, it queues the next sources of the backlog (most searched first, then by priority and
 * age) for compilation, `batch` at a time, and waits for them before it queues more. They run
 * as task priority 3 and model priority 2: uploads, questions and the dream cycle go first.
 */
import type { Sql } from "@cb/db";
import { metrics } from "@cb/shared";
import { defineTask, type TaskDefinition } from "@cb/tasks";

export interface IdleCompileDeps {
  sql: Sql;
  /** Marks the source to compile and queues its pipeline task (`IngestService.compileNow`). */
  compileNow: (sourceId: string, priority: number) => Promise<string>;
  /** True when a real chat model is up and free (no queue, a free slot). */
  ready: () => boolean;
  /** Pause between two checks (ms). */
  intervalMs: number;
  /** Sources compiled at the same time (default 1). */
  batch?: number;
  /** Task name (default "idle-compile"). Tests sharing one database use unique names. */
  name?: string;
  /** Only these vaults (tests sharing one database); default every vault. */
  vaultIds?: string[];
}

export interface IdleCompileState {
  /** Sources queued by this task whose compilation has not ended yet. */
  inflight: string[];
  /** Sources queued since the task started. */
  queued: number;
}

export type IdleCompileTask = TaskDefinition<Record<string, never>, IdleCompileState, null>;

/** Task priority of the compilations queued by this task. */
export const IDLE_PRIORITY = 3;

export function defineIdleCompileTask(d: IdleCompileDeps): IdleCompileTask {
  const batch = Math.max(1, d.batch ?? 1);
  return defineTask<Record<string, never>, IdleCompileState, null>({
    name: d.name ?? "idle-compile",
    version: 1,
    firstPhase: "tick",
    initial: () => ({ inflight: [], queued: 0 }),
    phases: {
      async tick(ctx) {
        const s = ctx.task.state;
        const sleep = (state: IdleCompileState) => ctx.sleepUntil(new Date(Date.now() + d.intervalMs), "tick", state);
        // compilations of this task still running or waiting
        const inflight = s.inflight.length
          ? (
              await d.sql<{ id: string }[]>`
                select s.id from sources s join tasks t on t.id = s.task_id
                where s.id = any(${s.inflight}) and t.status not in ('done', 'failed', 'cancelled')`
            ).map((r) => r.id)
          : [];
        const free = batch - inflight.length;
        if (free <= 0 || !d.ready()) return sleep({ ...s, inflight });
        // never asked to compile (imports, links of a run with compile off), at I1 or I2, no task running
        const next = await d.sql<{ id: string }[]>`
          select s.id from sources s
          where s.level between 1 and 2 and not s.compile and s.status not in ('failed', 'unsupported')
            and (${!d.vaultIds} or s.vault_id = any(${d.vaultIds ?? []}))
            and not exists (select 1 from tasks t where t.id = s.task_id and t.status not in ('done', 'failed', 'cancelled'))
          order by s.demand desc, s.priority, s.created_at, s.id limit ${free}`;
        for (const r of next) await d.compileNow(r.id, IDLE_PRIORITY);
        if (next.length) {
          metrics.inc("idle_compiles", {}, next.length);
          ctx.log.info("idle compile", { sources: next.length, queued: s.queued + next.length });
        }
        return sleep({ inflight: [...inflight, ...next.map((r) => r.id)], queued: s.queued + next.length });
      },
    },
  });
}
