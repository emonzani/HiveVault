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
 */
import type { Sql } from "@cb/db";

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
    const [r] = await this.sql<{ n: number; last: Date | null }[]>`
      select count(*)::int as n, max(at) as last from auth_failures
      where username = ${username.trim().toLowerCase()} and at > now() - interval '24 hours'`;
    const lock = this.lockFor(r!.n);
    if (!lock || !r!.last) return { locked: false, retryAfterMs: 0, failures: r!.n };
    const until = r!.last.getTime() + lock;
    const retry = until - Date.now();
    return { locked: retry > 0, retryAfterMs: Math.max(0, retry), failures: r!.n };
  }

  async fail(username: string, ip?: string | null): Promise<void> {
    await this.sql`insert into auth_failures (username, ip) values (${username.trim().toLowerCase()}, ${ip ?? null})`;
  }

  async clear(username: string): Promise<void> {
    await this.sql`delete from auth_failures where username = ${username.trim().toLowerCase()}`;
  }
}
