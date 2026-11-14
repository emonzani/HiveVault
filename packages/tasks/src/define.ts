import type { Sql, TransactionSql } from "@cb/db";
import type { Logger } from "@cb/shared";

/**
 * Durable tasks: a task is a state machine whose state is saved at
 * the end of every phase. A restarted process continues from the last saved phase.
 */

export type PhaseOutcome<S, R> =
  | { type: "next"; phase: string; state: S }
  | { type: "done"; result: R }
  | { type: "sleep"; until: Date; phase: string; state: S }
  | { type: "wait"; phase: string; state: S }
  | { type: "fail"; error: string };

export interface TaskRow<I, S> {
  id: string;
  name: string;
  version: number;
  requestId: string | null;
  parentId: string | null;
  phase: string;
  input: I;
  state: S;
  attempts: number;
  priority: number;
}

export interface EffectOptions {
  /**
   * true: the effect can run again with the same result (reads, idempotent writes).
   * false: an effect interrupted after its intent was saved is not repeated;
   * `InterruptedEffectError` is thrown instead, so the phase decides.
   */
  replaySafe: boolean;
}

export interface SpawnOptions {
  requestId?: string;
  priority?: number;
}

export interface ChildSummary {
  id: string;
  name: string;
  status: "done" | "failed" | "cancelled";
  result: unknown;
  error: string | null;
}

export interface PhaseContext<I, S, R> {
  readonly task: TaskRow<I, S>;
  readonly sql: Sql;
  readonly signal: AbortSignal;
  readonly log: Logger;

  /** Side effect outside the database, journaled: intent before, result after. */
  effect<T>(key: string, fn: () => Promise<T>, opts: EffectOptions): Promise<T>;
  /**
   * Database side effect, exactly once: the work and its journal entry commit in the same
   * transaction. On resume a committed effect returns its stored result without running.
   */
  effectTx<T>(key: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T>;
  /** Creates a child task (idempotent per requestId; default requestId = `${task.id}:${key}`). */
  spawn<CI>(def: TaskDefinition<CI, any, any>, key: string, input: CI, opts?: SpawnOptions): Promise<string>;
  /** Results of the finished children (after a `wait`). */
  children(): Promise<ChildSummary[]>;

  next(phase: string, state: S): PhaseOutcome<S, R>;
  done(result: R): PhaseOutcome<S, R>;
  sleepUntil(until: Date, phase: string, state: S): PhaseOutcome<S, R>;
  /** Suspends the task until all its children are finished, then runs `phase`. */
  waitChildren(phase: string, state: S): PhaseOutcome<S, R>;
  fail(error: string): PhaseOutcome<S, R>;
}

export type PhaseHandler<I, S, R> = (ctx: PhaseContext<I, S, R>) => Promise<PhaseOutcome<S, R>>;

export interface TaskDefinition<I, S, R> {
  name: string;
  version: number;
  firstPhase: string;
  initial: (input: I) => S;
  phases: Record<string, PhaseHandler<I, S, R>>;
  maxAttempts?: number;
  /** Delay before retry number n (1-based). Default: 1 s, 2 s, 4 s ... max 5 min. */
  backoffMs?: (attempt: number) => number;
}

export function defineTask<I, S, R>(def: TaskDefinition<I, S, R>): TaskDefinition<I, S, R> {
  if (!def.phases[def.firstPhase]) throw new Error(`Task ${def.name}: first phase "${def.firstPhase}" is not defined`);
  return def;
}

export class InterruptedEffectError extends Error {
  constructor(readonly key: string) {
    super(`Effect "${key}" was interrupted after it started and is not replay-safe`);
    this.name = "InterruptedEffectError";
  }
}

export class LeaseLostError extends Error {
  constructor(id: string) {
    super(`Task ${id}: lease lost (another worker owns it)`);
    this.name = "LeaseLostError";
  }
}
