/**
 * Reliability of a compiled page, computed when it is read (never stored: it changes with the
 * clock and with the documents).
 *
 * - `sources`: distinct documents the page cites.
 * - `conflicts`: `> [!conflict]` blocks in the page (two documents give different values).
 * - `verified`: a person confirmed the page (`verified_by`, `verified_at` in the frontmatter).
 *   A confirmation counts only when it is not older than the newest document the page cites.
 * - `reviewAfter`: the date after which a person should look at the page again: `review_after`
 *   (a date) in the frontmatter, or `review_every` (days), or the default of the vault for the
 *   kind of page (`vaults.review_days`), counted from the confirmation, the newest cited
 *   document or the creation of the page, whichever is latest.
 * - `level`: "bassa" with a conflict, without sources or past the review date; "alta" with at
 *   least two sources or a valid confirmation; else "media".
 */
import type { Sql, TransactionSql } from "@cb/db";
import { extractCitations } from "./markdown.ts";

export interface Reliability {
  sources: number;
  conflicts: number;
  verified: { by: string; at: string } | null;
  /** YYYY-MM-DD of the newest cited document the reader can see. */
  newest: string | null;
  reviewAfter: string | null;
  reviewDue: boolean;
  level: "alta" | "media" | "bassa";
}

export interface ReliabilityInput {
  type: string;
  body: string;
  frontmatter: Record<string, unknown>;
  /** YYYY-MM-DD */
  createdAt: string;
  /** Creation dates (YYYY-MM-DD) of the cited documents, by id. */
  sourceDates: Map<string, string>;
  /** Default review periods of the vault, in days, by kind of page ("entity", "decision") or full type. */
  reviewDays: Record<string, unknown>;
  /** YYYY-MM-DD; default today (UTC). */
  today?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}/;
const day = (v: unknown): string | null => (typeof v === "string" && DAY.test(v) ? v.slice(0, 10) : v instanceof Date ? v.toISOString().slice(0, 10) : null);
const positive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 36500) : null;
};

export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** The review period of a page in days: its own, or the vault default for its type or kind. */
export function reviewPeriod(type: string, frontmatter: Record<string, unknown>, reviewDays: Record<string, unknown>): number | null {
  return positive(frontmatter.review_every) ?? positive(reviewDays[type]) ?? positive(reviewDays[type.split("/")[0]!]);
}

export function reliability(i: ReliabilityInput): Reliability {
  const cited = [...new Set(extractCitations(i.body).map((c) => c.source).filter((s) => s.startsWith("src_")))];
  const newest = cited.map((s) => i.sourceDates.get(s)).filter((d): d is string => !!d).sort().at(-1) ?? null;
  const conflicts = (i.body.match(/^>\s*\[!conflict\]/gim) ?? []).length;
  const by = typeof i.frontmatter.verified_by === "string" ? i.frontmatter.verified_by.trim() : "";
  const at = day(i.frontmatter.verified_at);
  const verified = by && at && (!newest || at >= newest) ? { by, at } : null;
  const period = reviewPeriod(i.type, i.frontmatter, i.reviewDays);
  const from = [verified?.at, newest, i.createdAt].filter((d): d is string => !!d).sort().at(-1)!;
  const reviewAfter = day(i.frontmatter.review_after) ?? (period ? addDays(from, period) : null);
  const today = i.today ?? new Date().toISOString().slice(0, 10);
  // an explicit date stops counting once a person confirms the page after it
  const reviewDue = !!reviewAfter && reviewAfter <= today && !(verified && verified.at >= reviewAfter);
  // a page that cites only other pages (a synthesis) counts its citations as sources
  const sources = cited.length || new Set(extractCitations(i.body).map((c) => c.source)).size;
  const level = conflicts > 0 || sources === 0 || reviewDue ? "bassa" : sources >= 2 || verified ? "alta" : "media";
  return { sources, conflicts, verified, newest, reviewAfter, reviewDue, level };
}

/**
 * The reliability of several pages, read with `tx` (a reader transaction gives the reader's
 * view: documents it cannot see give no date). Source pages are left out.
 */
export async function reliabilityOf(tx: Sql | TransactionSql, pageIds: string[], today?: string): Promise<Map<string, Reliability>> {
  const out = new Map<string, Reliability>();
  if (!pageIds.length) return out;
  const pages = await tx<{ id: string; type: string; body: string; frontmatter: Record<string, unknown>; createdAt: string; reviewDays: Record<string, unknown> }[]>`
    select p.id, p.type, p.body, p.frontmatter, to_char(p.created_at, 'YYYY-MM-DD') as "createdAt", coalesce(v.review_days, '{}'::jsonb) as "reviewDays"
    from pages p join vaults v on v.id = p.vault_id
    where p.id = any(${pageIds}) and split_part(p.type, '/', 1) <> 'source'`;
  const ids = [...new Set(pages.flatMap((p) => extractCitations(p.body).map((c) => c.source)).filter((s) => s.startsWith("src_")))];
  const dates = new Map<string, string>();
  if (ids.length) {
    for (const s of await tx<{ id: string; d: string }[]>`select id, to_char(created_at, 'YYYY-MM-DD') as d from sources where id = any(${ids})`) dates.set(s.id, s.d);
  }
  for (const p of pages) {
    out.set(p.id, reliability({ type: p.type, body: p.body, frontmatter: p.frontmatter, createdAt: p.createdAt, sourceDates: dates, reviewDays: p.reviewDays, ...(today ? { today } : {}) }));
  }
  return out;
}

/** One line for the cloud agent and the interface: "affidabilità alta · 3 fonti · confermata il …". */
export function reliabilityLine(r: Reliability): string {
  const parts = [`affidabilità ${r.level}`, `${r.sources} ${r.sources === 1 ? "fonte" : "fonti"}`];
  if (r.conflicts) parts.push(`${r.conflicts} ${r.conflicts === 1 ? "conflitto aperto" : "conflitti aperti"}`);
  if (r.verified) parts.push(`confermata da ${r.verified.by} il ${r.verified.at}`);
  if (r.reviewDue) parts.push(`da ricontrollare dal ${r.reviewAfter}`);
  else if (r.reviewAfter) parts.push(`ricontrollo previsto il ${r.reviewAfter}`);
  return parts.join(" · ");
}
