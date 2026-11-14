/**
 * Sessions. The browser holds a random token (cookie, HttpOnly); the database holds its
 * sha256, so a database leak does not give working sessions. Two limits:
 *   idle     — no request for `idleMs` ends the session (sliding);
 *   absolute — the session ends `maxMs` after login, whatever the activity.
 * Every session has its own CSRF token for the double-submit check of state-changing calls.
 */
import type { Sql } from "@cb/db";
import { randomToken, sha256hex } from "./crypto.ts";
import { isUsable, principalCols, type PrincipalRow } from "./principals.ts";

export interface SessionOptions {
  idleMs?: number;
  maxMs?: number;
}

export interface SessionInfo {
  id: string;
  principalId: string;
  method: string;
  csrf: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export type LoginMethod = "totp" | "recovery" | "passkey" | "signature";

export class Sessions {
  readonly idleMs: number;
  readonly maxMs: number;

  constructor(
    private readonly sql: Sql,
    o: SessionOptions = {},
  ) {
    this.idleMs = o.idleMs ?? 12 * 3600_000;
    this.maxMs = o.maxMs ?? 7 * 24 * 3600_000;
  }

  async create(principalId: string, method: LoginMethod, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ token: string; csrf: string; expiresAt: Date; id: string }> {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const id = sha256hex(token);
    const expiresAt = new Date(Date.now() + this.maxMs);
    await this.sql`
      insert into sessions (id, principal_id, method, csrf, ip, user_agent, expires_at)
      values (${id}, ${principalId}, ${method}, ${csrf}, ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 300) ?? null}, ${expiresAt})`;
    await this.sql`update principals set last_seen_at = now() where id = ${principalId}`;
    return { token, csrf, expiresAt, id };
  }

  /** Resolves a token. Slides the idle timer (written at most once a minute). */
  async resolve(token: string): Promise<{ session: SessionInfo; principal: PrincipalRow } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const id = sha256hex(token);
    const [row] = await this.sql<(PrincipalRow & { s: SessionInfo })[]>`
      select ${this.sql.unsafe(principalCols("p"))},
             json_build_object('id', s.id, 'principalId', s.principal_id, 'method', s.method, 'csrf', s.csrf, 'ip', host(s.ip),
                               'userAgent', s.user_agent, 'createdAt', s.created_at, 'lastSeenAt', s.last_seen_at, 'expiresAt', s.expires_at) as s
      from sessions s join principals p on p.id = s.principal_id
      where s.id = ${id} and s.revoked_at is null and s.expires_at > now()
        and s.last_seen_at > now() - ${this.idleMs} * interval '1 millisecond'`;
    if (!row) return null;
    const { s, ...principal } = row;
    if (!isUsable(principal)) return null;
    await this.sql`update sessions set last_seen_at = now() where id = ${id} and last_seen_at < now() - interval '1 minute'`;
    return {
      session: { ...s, createdAt: new Date(s.createdAt), lastSeenAt: new Date(s.lastSeenAt), expiresAt: new Date(s.expiresAt) },
      principal,
    };
  }

  async revoke(id: string): Promise<boolean> {
    const r = await this.sql`update sessions set revoked_at = now() where id = ${id} and revoked_at is null`;
    return r.count > 0;
  }

  async revokeToken(token: string): Promise<boolean> {
    return this.revoke(sha256hex(token));
  }

  async revokeAllFor(principalId: string): Promise<number> {
    const r = await this.sql`update sessions set revoked_at = now() where principal_id = ${principalId} and revoked_at is null`;
    return r.count;
  }

  async list(principalId?: string): Promise<SessionInfo[]> {
    return this.sql<SessionInfo[]>`
      select id, principal_id as "principalId", method, '' as csrf, host(ip) as ip, user_agent as "userAgent",
             created_at as "createdAt", last_seen_at as "lastSeenAt", expires_at as "expiresAt"
      from sessions
      where revoked_at is null and expires_at > now() and last_seen_at > now() - ${this.idleMs} * interval '1 millisecond'
        and (${principalId ?? null}::text is null or principal_id = ${principalId ?? null})
      order by last_seen_at desc limit 500`;
  }

  /** Housekeeping (dream cycle): deletes sessions ended more than 30 days ago. */
  async purge(): Promise<number> {
    const r = await this.sql`delete from sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'`;
    return r.count;
  }
}
