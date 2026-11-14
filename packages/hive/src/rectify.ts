/**
 * Rectification of a generated page (GDPR art. 16). An administrator corrects a hive page or a
 * maintenance page at once; the dream cycle would write the old text again from the cells, so:
 *
 * 1. a curator item "rectification" lists the pages and sources the page cites: they are
 *    where the wrong data comes from and must be corrected too;
 * 2. while the item is open, the promotion keeps the corrected page as it is
 *    (`promoteSpace` skips it). A curator closes the item when the sources are corrected; the
 *    next night rebuilds the page from them.
 *
 * "personale" pages and sources are never listed: the administrator cannot see them, and they
 * are never promoted.
 */
import type { Sql } from "@cb/db";
import { extractCitations, normalizeTitle, PERSONAL } from "@cb/brain";
import { claimHash } from "./claims.ts";
import { upsertCuratorItem } from "./promote.ts";

export interface RectificationTargets {
  /** Pages of the cells cited by the page. */
  pages: { id: string; title: string; vaultId: string; vaultName: string }[];
  /** Documents cited by the page or by those pages. */
  sources: { id: string; name: string; vaultId: string; vaultName: string; classification: number }[];
}

/** What a corrected page cites, directly and through the pages it cites. */
export async function rectificationTargets(sql: Sql, bodies: string[]): Promise<RectificationTargets> {
  const ids = [...new Set(bodies.flatMap((b) => extractCitations(b).map((c) => c.source)))];
  if (!ids.length) return { pages: [], sources: [] };
  const pages = await sql<{ id: string; title: string; vaultId: string; vaultName: string; body: string; source: string | null }[]>`
    select p.id, p.title, p.vault_id as "vaultId", v.name as "vaultName", p.body, p.frontmatter->>'source' as source
    from pages p join vaults v on v.id = p.vault_id
    where p.id = any(${ids}) and p.classification <> ${PERSONAL} order by v.name, p.title`;
  const sourceIds = [
    ...new Set([...ids, ...pages.flatMap((p) => [...extractCitations(p.body).map((c) => c.source), ...(p.source ? [p.source] : [])])]),
  ];
  const sources = await sql<RectificationTargets["sources"]>`
    select s.id, coalesce(s.title, s.name) as name, s.vault_id as "vaultId", v.name as "vaultName", s.classification
    from sources s join vaults v on v.id = s.vault_id
    where s.id = any(${sourceIds}) and s.classification <> ${PERSONAL} order by v.name, 2`;
  return { pages: pages.map(({ body: _b, source: _s, ...p }) => p), sources };
}

/** Opens (or opens again) the curator item of a corrected page; returns its id. */
export async function openRectification(
  sql: Sql,
  page: { id: string; vaultId: string; title: string; frontmatter: Record<string, unknown> },
  by: string,
  targets: RectificationTargets,
): Promise<string> {
  const subject = typeof page.frontmatter.hive_subject === "string" ? page.frontmatter.hive_subject : normalizeTitle(page.title);
  const item = await upsertCuratorItem(sql, page.vaultId, "rectification", claimHash(`rectification|${page.id}`), subject, null, {
    pageId: page.id,
    title: page.title,
    by,
    at: new Date().toISOString(),
    pages: targets.pages,
    sources: targets.sources,
  });
  await sql`
    update curator_items set status = 'open', page_id = ${page.id}, resolution = null, resolved_by = null, resolved_at = null
    where id = ${item.id}`;
  return item.id;
}
