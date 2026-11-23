/**
 * Progressive lockout after failed logins, stored in Postgres (survives restarts and works
 * with more than one server process). Per username, not per IP: an attacker cannot avoid it
 * by changing address. The legitimate user waits at most `maxLockMs`.
 *
 *   failures in the last 24 h    lock after the last failure
 *   < threshold (5)              none
 *   5–9                          15 min
 *   10–14                        30 min
 *   ...                          doubles, up to 24 h
 *
 * A login reserves its attempt (`reserve`) before verification: check and insert run under a
 * per-username transaction lock, so concurrent attempts cannot all pass the check.
 */
import type { Sql, TransactionSql } from "@cb/db";

/** First key of the per-username advisory lock (the two-key form does not collide with one-key locks). */
const LOCK_NAMESPACE = 727_002;

export interface LockoutOptions {
  threshold?: number;
  baseLockMs?: number;
  maxLockMs?: number;
}

export class Lockout {
  private readonly threshold: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;

  constructor(
    private readonly sql: Sql,
    o: LockoutOptions = {},
  ) {
    this.threshold = o.threshold ?? 5;
    this.baseLockMs = o.baseLockMs ?? 15 * 60_000;
    this.maxLockMs = o.maxLockMs ?? 24 * 3600_000;
  }

  lockFor(failures: number): number {
    if (failures < this.threshold) return 0;
    const level = Math.floor((failures - this.threshold) / this.threshold);
    return Math.min(this.baseLockMs * 2 ** level, this.maxLockMs);
  }

  async check(username: string): Promise<{ locked: boolean; retryAfterMs: number; failures: number }> {
    return this.state(this.sql, username.trim().toLowerCase());
  }

  private async state(q: Sql | TransactionSql, name: string): Promise<{ locked: boolean; retryAfterMs: number; failures: number }> {
    const [r] = await q<{ n: number; last: Date | null }[]>`
      select count(*)::int as n, max(at) as last from auth_failures
      where username = ${name} and at > now() - interval '24 hours'`;
    const lock = this.lockFor(r!.n);
    if (!lock || !r!.last) return { locked: false, retryAfterMs: 0, failures: r!.n };
    const until = r!.last.getTime() + lock;
    const retry = until - Date.now();
    return { locked: retry > 0, retryAfterMs: Math.max(0, retry), failures: r!.n };
  }

  /**
   * `check` and, when not locked, an attempt row inserted in the same transaction under a
   * per-username lock. The row counts as a failure for every later check until the login ends:
   * `fail` (wrong credentials), `clear` (success) or `release` (verification threw).
   * `id` is null when locked (nothing inserted).
   */
  async reserve(username: string, ip?: string | null): Promise<{ locked: boolean; retryAfterMs: number; failures: number; id: number | null }> {
    const name = username.trim().toLowerCase();
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${name}))`;
      const s = await this.state(tx, name);
      if (s.locked) return { ...s, id: null };
      const [row] = await tx<{ id: number }[]>`insert into auth_failures (username, ip) values (${name}, ${ip ?? null}) returning id`;
      return { ...s, id: row!.id };
    });
  }

  /**
   * Records a failure. With a reservation, the reserved row becomes the failure, dated now
   * (the time of the failed verification). A new row is inserted when there is no reservation
   * or a concurrent successful login removed it.
   */
  async fail(username: string, ip?: string | null, reservation?: number | null): Promise<void> {
    if (reservation != null) {
      const moved = await this.sql`update auth_failures set at = now() where id = ${reservation}`;
      if (moved.count > 0) return;
    }
    await this.sql`insert into auth_failures (username, ip) values (${username.trim().toLowerCase()}, ${ip ?? null})`;
  }

  /** Removes a reservation whose verification did not finish (an error, not a wrong credential). */
  async release(reservation: number | null): Promise<void> {
    if (reservation == null) return;
    await this.sql`delete from auth_failures where id = ${reservation}`;
  }

  async clear(username: string): Promise<void> {
    await this.sql`delete from auth_failures where username = ${username.trim().toLowerCase()}`;
  }
}
