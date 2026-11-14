/**
 * Audit log (plan N5): who did what, when, from where. Writes are buffered and flushed in
 * one multi-row insert every second (or every 200 events), so auditing every API read does
 * not add a database round trip to it. Security events (logins, admin changes) use
 * `writeNow`, which does not wait for the buffer.
 */
import type { Sql } from "@cb/db";
import { createLogger, metrics } from "@cb/shared";

export interface AuditEvent {
  principalId?: string | null;
  action: string;
  resource?: string | null;
  outcome?: "ok" | "denied" | "error";
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown> | null;
}

export interface AuditRow extends Required<Omit<AuditEvent, "data">> {
  id: number;
  at: Date;
  data: Record<string, unknown> | null;
}

const log = createLogger("audit");

const CLASS = ["pubblico", "interno", "riservato", "segreto", "personale"];
/** Metrics from the audit events: actions by outcome; page reads by channel and classification. */
function count(e: AuditEvent): void {
  metrics.inc("audit_events", { action: e.action, outcome: e.outcome ?? "ok" });
  if (e.action === "page.read" || e.action === "source.read") {
    const d = e.data ?? {};
    const via = String(d.via ?? "") === "mcp" ? "mcp" : String(d.via ?? "") === "apikey" ? "api" : "web";
    metrics.inc("reads", { via, classification: CLASS[Number(d.classification ?? 1)] ?? "interno" });
  }
}

export interface ChainCheck {
  /** Security events checked (the chained rows). */
  rows: number;
  first: number | null;
  last: number | null;
  /** First problem found, or null when the chain is intact. */
  broken: { seq: number; reason: "hash" | "link" | "gap" | "head" } | null;
}

/**
 * Checks the hash chain of the audit log (migration 014): every security event hashes its
 * fields with the hash before it, so a changed, removed or inserted row breaks the chain from
 * there on. Retention removes the oldest rows only: the first row left is the anchor. The last
 * row must match the chain head, so rows removed at the end show too.
 */
export async function verifyAuditChain(sql: Sql, batch = 5000): Promise<ChainCheck> {
  const res: ChainCheck = { rows: 0, first: null, last: null, broken: null };
  // the head first: rows written while the check runs come after it and are left for the next check
  const [head] = await sql<{ seq: string; hash: string | null }[]>`select seq::text, encode(hash, 'hex') as hash from audit_chain_head`;
  const headSeq = Number(head?.seq ?? 0);
  let prev: { seq: number; hash: string } | null = null;
  for (;;) {
    const rows: { s: string; prev: string | null; hash: string; ok: boolean }[] = await sql`
      select seq::text as s, encode(prev_hash, 'hex') as prev, encode(hash, 'hex') as hash,
             cb_audit_row_hash(prev_hash, seq, at, principal_id, action, resource, outcome, ip, user_agent, data) = hash as ok
      from audit_log where seq is not null and seq > ${prev?.seq ?? 0} and seq <= ${headSeq} order by seq limit ${batch}`;
    for (const r of rows) {
      const seq = Number(r.s);
      res.first ??= seq;
      res.last = seq;
      res.rows++;
      if (!r.ok) return { ...res, broken: { seq, reason: "hash" } };
      if (prev && seq !== prev.seq + 1) return { ...res, broken: { seq, reason: "gap" } };
      if (prev && r.prev !== prev.hash) return { ...res, broken: { seq, reason: "link" } };
      prev = { seq, hash: r.hash };
    }
    if (rows.length < batch) break;
  }
  // the last rows removed: the chain ends before its head
  if (headSeq > 0 && (prev?.seq !== headSeq || prev.hash !== head?.hash)) return { ...res, broken: { seq: headSeq, reason: "head" } };
  return res;
}

export class AuditLog {
  private buffer: AuditEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly o: { flushMs?: number; maxBuffer?: number } = {},
  ) {}

  write(e: AuditEvent): void {
    count(e);
    this.buffer.push(e);
    if (this.buffer.length >= (this.o.maxBuffer ?? 200)) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.o.flushMs ?? 1000);
  }

  async writeNow(e: AuditEvent): Promise<void> {
    count(e);
    await this.insert([e]);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    const batch = this.buffer.splice(0);
    if (!batch.length) return;
    this.flushing = this.insert(batch).catch((err) => {
      log.error("audit write failed", { error: String(err), events: batch.length });
    });
    await this.flushing;
  }

  async stop(): Promise<void> {
    await this.flush();
  }

  private async insert(events: AuditEvent[]): Promise<void> {
    const rows = events.map((e) => ({
      principal_id: e.principalId ?? null,
      action: e.action,
      resource: e.resource ?? null,
      outcome: e.outcome ?? "ok",
      ip: e.ip ?? null,
      user_agent: e.userAgent?.slice(0, 300) ?? null,
      data: e.data ? this.sql.json(e.data as never) : null,
    }));
    await this.sql`insert into audit_log ${this.sql(rows as never)}`;
  }

  async query(f: { principalId?: string; action?: string; outcome?: string; since?: Date; until?: Date; limit?: number; beforeId?: number } = {}): Promise<AuditRow[]> {
    const action = f.action ? (f.action.endsWith("*") ? f.action.slice(0, -1) + "%" : f.action) : null;
    return this.sql<AuditRow[]>`
      select id, at, principal_id as "principalId", action, resource, outcome, host(ip) as ip, user_agent as "userAgent", data
      from audit_log
      where (${f.principalId ?? null}::text is null or principal_id = ${f.principalId ?? null})
        and (${action}::text is null or action like ${action})
        and (${f.outcome ?? null}::text is null or outcome = ${f.outcome ?? null})
        and (${f.since ?? null}::timestamptz is null or at >= ${f.since ?? null})
        and (${f.until ?? null}::timestamptz is null or at < ${f.until ?? null})
        and (${f.beforeId ?? null}::bigint is null or id < ${f.beforeId ?? null})
      order by id desc limit ${Math.min(f.limit ?? 100, 1000)}`;
  }
}
