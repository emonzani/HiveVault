/**
 * Reads for the user interface (plan §9.2): folder tree, full page with resolved links and
 * citations, backlinks and unlinked mentions, history, title suggestions and the global graph.
 * Every function runs through `withReader`, so Row Level Security filters vaults and
 * classification; the vault filters in the queries are there for partition pruning.
 */
import type { Sql, TransactionSql } from "@cb/db";
import { withReader, type Principal } from "./access.ts";
import { extractCitations, normalizeTitle } from "./markdown.ts";
import { pageCols, type Page } from "./pages.ts";

/** Sidebar folders: first part of the page type. */
export const FOLDERS = ["entity", "concept", "decision", "synthesis", "source", "note"] as const;

export interface FolderCount {
  folder: string;
  count: number;
}

export interface PageListItem {
  id: string;
  title: string;
  type: string;
  path: string;
  tokens: number;
  classification: number;
  updatedAt: Date;
}

export interface PageList {
  items: PageListItem[];
  /** Keyset cursor for the next page of results, or null at the end. */
  next: string | null;
}

export interface OutLink {
  raw: string;
  target: string;
  pageId: string | null;
  title: string | null;
  vaultId: string | null;
}

export interface CitationRef {
  ref: string;
  kind: "source" | "page" | "unknown";
  id: string;
  name: string | null;
  /** Start of the cited chunk, for the hover card. */
  excerpt: string | null;
  chunkId: string | null;
}

export interface FullPage extends Page {
  aliases: string[];
  links: OutLink[];
  citations: CitationRef[];
  backlinks: number;
}

export interface Backlink {
  id: string;
  title: string;
  type: string;
  vaultId: string;
  /** Text around the link (or the mention). */
  context: string;
}

export interface VersionItem {
  version: number;
  title: string;
  author: string | null;
  createdAt: Date;
  current: boolean;
}

export interface Suggestion {
  id: string;
  title: string;
  type: string;
  vaultId: string;
  /** The alias that matched, when it is not the title. */
  alias: string | null;
}

export interface GraphData {
  nodes: { id: string; title: string; type: string; vaultId: string; degree: number }[];
  /** `kind`: wikilink, embed or a typed relation; `cross`: the two pages are in different vaults. */
  edges: { from: string; to: string; kind: string; cross?: boolean }[];
  /** True when more nodes exist beyond the limit (progressive loading). */
  more: boolean;
}

const encodeCursor = (title: string, id: string) => Buffer.from(JSON.stringify([title, id])).toString("base64url");
function decodeCursor(c: string | undefined): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as unknown;
    return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string") ? (v as [string, string]) : null;
  } catch {
    return null;
  }
}

export async function folderCounts(sql: Sql, p: Principal, vaultId: string): Promise<FolderCount[]> {
  return withReader(sql, p, (tx) => tx<FolderCount[]>`
    select split_part(type, '/', 1) as folder, count(*)::int as count
    from pages where vault_id = ${vaultId} group by 1 order by 1`);
}

/** Pages of one folder in title order (keyset pagination, index pages_vault_folder_title_idx). */
export async function listPages(sql: Sql, p: Principal, vaultId: string, folder: string, o: { cursor?: string; limit?: number } = {}): Promise<PageList> {
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 500);
  const after = decodeCursor(o.cursor);
  const rows = await withReader(sql, p, (tx) => tx<(PageListItem & { lt: string })[]>`
    select id, title, type, path, tokens, classification, updated_at as "updatedAt", lower(title) as lt
    from pages
    where vault_id = ${vaultId} and split_part(type, '/', 1) = ${folder}
      and (${after?.[0] ?? null}::text is null or (lower(title), id) > (${after?.[0] ?? ""}::text, ${after?.[1] ?? ""}::text))
    order by lower(title), id
    limit ${limit + 1}`);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(({ lt: _lt, ...r }) => r), next: more && last ? encodeCursor(last.lt, last.id) : null };
}

/** Recently changed pages of the readable vaults (home and "recent" list). */
export async function recentPages(sql: Sql, p: Principal, limit = 30): Promise<(PageListItem & { vaultId: string })[]> {
  return withReader(sql, p, (tx) => tx<(PageListItem & { vaultId: string })[]>`
    select id, vault_id as "vaultId", title, type, path, tokens, classification, updated_at as "updatedAt"
    from pages where vault_id = any(${p.vaults}) order by updated_at desc limit ${Math.min(limit, 200)}`);
}

export async function fullPage(sql: Sql, p: Principal, id: string): Promise<FullPage | undefined> {
  return withReader(sql, p, async (tx) => {
    const [page] = await tx<Page[]>`select ${tx.unsafe(pageCols())} from pages where id = ${id}`;
    if (!page) return undefined;
    const fmAliases = Array.isArray(page.frontmatter.aliases) ? (page.frontmatter.aliases as unknown[]).map(String) : [];
    const links = await tx<OutLink[]>`
      select l.target_raw as raw, l.target_norm as target, d.id as "pageId", d.title, d.vault_id as "vaultId"
      from links l left join pages d on d.id = l.dst_page
      where l.src_page = ${id} order by l.ord`;
    // Links stay unresolved when the target lives in another vault (the store resolves inside
    // the page's vault). The reader may see the target elsewhere: resolve by exact title or
    // alias in the readable vaults, the page's own vault first.
    const open = [...new Set(links.filter((l) => !l.pageId).map((l) => l.target))];
    if (open.length) {
      const found = await tx<{ alias: string; id: string; title: string; vaultId: string }[]>`
        select distinct on (a.alias_norm) a.alias_norm as alias, p.id, p.title, p.vault_id as "vaultId"
        from aliases a join pages p on p.id = a.page_id
        where a.vault_id = any(${p.vaults}) and a.alias_norm = any(${open})
        order by a.alias_norm, (p.vault_id = ${page.vaultId}) desc, a.is_title desc, p.importance desc`;
      const byAlias = new Map(found.map((f) => [f.alias, f]));
      for (const l of links) {
        const f = !l.pageId ? byAlias.get(l.target) : undefined;
        if (f) Object.assign(l, { pageId: f.id, title: f.title, vaultId: f.vaultId });
      }
    }
    const names = await pageNames(tx, id);
    const [{ n }] = (await tx`
      select count(distinct src_page)::int as n from links
      where vault_id = any(${p.vaults}) and src_page <> ${id}
        and (dst_page = ${id} or (dst_page is null and vault_id <> ${page.vaultId} and target_norm = any(${names})))`) as unknown as [{ n: number }];
    return { ...page, aliases: fmAliases, links, citations: await resolveCitations(tx, p.vaults, page.body), backlinks: n };
  });
}

/**
 * Normalized title and aliases of a page. The page store resolves a [[link]] inside the vault
 * of the linking page; a link from another vault stays unresolved and waits on these names.
 * Reads count such links as links to the page when the reader can see both pages
 * (`l.dst_page is null and l.target_norm = any(names)`, index links_unresolved_idx).
 */
async function pageNames(tx: TransactionSql, pageId: string): Promise<string[]> {
  return (await tx<{ a: string }[]>`select alias_norm as a from aliases where page_id = ${pageId}`).map((r) => r.a);
}

/** ^[src_x#c3] → source name and the start of chunk 3; ^[ent_y] → page title. */
async function resolveCitations(tx: TransactionSql, vaults: string[], body: string): Promise<CitationRef[]> {
  const cites = extractCitations(body);
  if (!cites.length) return [];
  const ids = [...new Set(cites.map((c) => c.source))];
  const sources = new Map(
    (await tx<{ id: string; name: string; title: string | null }[]>`select id, name, title from sources where vault_id = any(${vaults}) and id = any(${ids})`).map((s) => [s.id, s]),
  );
  const pages = new Map((await tx<{ id: string; title: string }[]>`select id, title from pages where vault_id = any(${vaults}) and id = any(${ids})`).map((x) => [x.id, x]));
  const chunkIds = cites.filter((c) => sources.has(c.source) && c.chunk && /^c\d+$/.test(c.chunk)).map((c) => `${c.source}:${c.chunk!.slice(1)}`);
  const chunks = new Map(
    chunkIds.length
      ? (await tx<{ id: string; text: string }[]>`select id, left(text, 280) as text from chunks where vault_id = any(${vaults}) and id = any(${[...new Set(chunkIds)]})`).map((c) => [c.id, c.text])
      : [],
  );
  const seen = new Set<string>();
  const out: CitationRef[] = [];
  for (const c of cites) {
    if (seen.has(c.ref)) continue;
    seen.add(c.ref);
    const s = sources.get(c.source);
    const pg = pages.get(c.source);
    const chunkId = s && c.chunk && /^c\d+$/.test(c.chunk) ? `${c.source}:${c.chunk.slice(1)}` : null;
    out.push({
      ref: c.ref,
      kind: s ? "source" : pg ? "page" : "unknown",
      id: c.source,
      name: s ? (s.title ?? s.name) : (pg?.title ?? null),
      excerpt: chunkId ? (chunks.get(chunkId) ?? null) : null,
      chunkId,
    });
  }
  return out;
}

/**
 * Pages that link to this page, and pages that name it without a link ("unlinked mentions",
 * full-text phrase match of the title and aliases in the readable vaults).
 */
export async function backlinks(sql: Sql, p: Principal, id: string, limit = 100): Promise<{ linked: Backlink[]; mentions: Backlink[] }> {
  return withReader(sql, p, async (tx) => {
    const [page] = await tx<{ title: string; frontmatter: Record<string, unknown>; vaultId: string }[]>`
      select title, frontmatter, vault_id as "vaultId" from pages where id = ${id}`;
    if (!page) return { linked: [], mentions: [] };
    const linked = await tx<Backlink[]>`
      select distinct on (s.id) s.id, s.title, s.type, s.vault_id as "vaultId",
             substr(s.body, greatest(1, strpos(s.body, l.target_raw) - 90), length(l.target_raw) + 180) as context
      from links l join pages s on s.id = l.src_page
      where l.vault_id = any(${p.vaults}) and l.src_page <> ${id}
        and (l.dst_page = ${id} or (l.dst_page is null and l.vault_id <> ${page.vaultId} and l.target_norm = any(${await pageNames(tx, id)})))
      order by s.id limit ${limit}`;
    const names = [page.title, ...(Array.isArray(page.frontmatter.aliases) ? (page.frontmatter.aliases as unknown[]).map(String) : [])]
      .map((n) => n.trim())
      .filter((n) => n.length >= 3)
      .slice(0, 5);
    let mentions: Backlink[] = [];
    if (names.length) {
      const q = names.map((n) => `"${n.replace(/"/g, "")}"`).join(" or ");
      const exclude = [id, ...linked.map((l) => l.id)];
      mentions = await tx<Backlink[]>`
        select distinct on (s.id) s.id, s.title, s.type, s.vault_id as "vaultId", left(c.text, 240) as context
        from chunks c join pages s on s.id = c.page_id
        where c.vault_id = any(${p.vaults}) and c.page_id is not null
          and c.tsv @@ (websearch_to_tsquery('italian', ${q}) || websearch_to_tsquery('english', ${q}))
          and c.page_id <> all(${exclude})
        order by s.id limit 30`;
    }
    return { linked, mentions };
  });
}

export async function versions(sql: Sql, p: Principal, id: string): Promise<VersionItem[] | undefined> {
  return withReader(sql, p, async (tx) => {
    const [page] = await tx<{ version: number; title: string; updatedAt: Date; author: string | null }[]>`
      select version, title, updated_at as "updatedAt", frontmatter->>'author' as author from pages where id = ${id}`;
    if (!page) return undefined;
    const old = await tx<VersionItem[]>`
      select version, title, author, created_at as "createdAt", false as current
      from page_versions where page_id = ${id} order by version desc limit 200`;
    return [{ version: page.version, title: page.title, author: null, createdAt: page.updatedAt, current: true }, ...old];
  });
}

export async function version(sql: Sql, p: Principal, id: string, v: number): Promise<{ version: number; title: string; body: string; frontmatter: Record<string, unknown> } | undefined> {
  return withReader(sql, p, async (tx) => {
    const [cur] = await tx<{ version: number; title: string; body: string; frontmatter: Record<string, unknown> }[]>`
      select version, title, body, frontmatter from pages where id = ${id}`;
    if (!cur) return undefined;
    if (cur.version === v) return cur;
    const [old] = await tx<{ version: number; title: string; body: string; frontmatter: Record<string, unknown> }[]>`
      select version, title, body, frontmatter from page_versions where page_id = ${id} and version = ${v}`;
    return old;
  });
}

/**
 * Title and alias suggestions for the quick switcher and the link autocomplete: prefix match
 * first, then trigram similarity.
 */
export async function suggest(sql: Sql, p: Principal, q: string, o: { vaultId?: string; limit?: number } = {}): Promise<Suggestion[]> {
  const norm = normalizeTitle(q);
  const limit = Math.min(o.limit ?? 12, 50);
  const vaults = o.vaultId ? p.vaults.filter((v) => v === o.vaultId) : p.vaults;
  if (!vaults.length) return [];
  return withReader(sql, p, async (tx) => {
    if (!norm) {
      return tx<Suggestion[]>`
        select id, title, type, vault_id as "vaultId", null as alias from pages
        where vault_id = any(${vaults}) order by updated_at desc limit ${limit}`;
    }
    const like = norm.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
    const rows = await tx<(Suggestion & { isTitle: boolean; rank: number })[]>`
      (select p.id, p.title, p.type, p.vault_id as "vaultId", a.alias_norm as alias, a.is_title as "isTitle", 0 as rank, p.importance
       from aliases a join pages p on p.id = a.page_id
       where a.vault_id = any(${vaults}) and a.alias_norm like ${like}
       order by a.is_title desc, p.importance desc, length(a.alias_norm) limit ${limit})
      union all
      (select p.id, p.title, p.type, p.vault_id as "vaultId", a.alias_norm as alias, a.is_title as "isTitle", 1 as rank, p.importance
       from aliases a join pages p on p.id = a.page_id
       where a.vault_id = any(${vaults}) and a.alias_norm % ${norm}
       order by similarity(a.alias_norm, ${norm}) desc limit ${limit})`;
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const r of rows.sort((a, b) => a.rank - b.rank)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, title: r.title, type: r.type, vaultId: r.vaultId, alias: r.isTitle ? null : r.alias });
      if (out.length >= limit) break;
    }
    return out;
  });
}

/**
 * Global graph: the most linked pages of the chosen vaults (optionally of some folders) and the
 * links between them. `offset` loads the next ring of nodes (progressive loading).
 */
/**
 * Tags of the readable pages, the most used first: the editor suggests them, so one tag stays one
 * tag instead of drifting into several spellings.
 */
export async function tagCounts(sql: Sql, p: Principal, o: { vaultId?: string; limit?: number } = {}): Promise<{ tag: string; pages: number }[]> {
  const vaults = o.vaultId ? p.vaults.filter((v) => v === o.vaultId) : p.vaults;
  if (!vaults.length) return [];
  return withReader(sql, p, (tx) => tx<{ tag: string; pages: number }[]>`
    select t as tag, count(*)::int as pages from pages, unnest(tags) as t
    where vault_id = any(${vaults}) group by t order by count(*) desc, t limit ${Math.min(o.limit ?? 300, 1000)}`);
}

export async function graph(sql: Sql, p: Principal, o: { vaults?: string[]; folders?: string[]; limit?: number; offset?: number } = {}): Promise<GraphData> {
  const vaults = o.vaults?.length ? p.vaults.filter((v) => o.vaults!.includes(v)) : p.vaults;
  const limit = Math.min(o.limit ?? 300, 2000);
  const offset = Math.max(o.offset ?? 0, 0);
  if (!vaults.length) return { nodes: [], edges: [], more: false };
  return withReader(sql, p, async (tx) => {
    const folders = o.folders?.length ? o.folders : null;
    const nodes = await tx<GraphData["nodes"]>`
      with deg as (
        select dst_page as id, count(*)::int as d from links
        where vault_id = any(${vaults}) and dst_page is not null group by dst_page
      )
      select p.id, p.title, p.type, p.vault_id as "vaultId", coalesce(deg.d, 0) as degree
      from pages p left join deg on deg.id = p.id
      where p.vault_id = any(${vaults}) and (${folders}::text[] is null or split_part(p.type, '/', 1) = any(${folders}::text[]))
      order by coalesce(deg.d, 0) desc, p.importance desc, p.id
      limit ${limit + 1} offset ${offset}`;
    const more = nodes.length > limit;
    const list = nodes.slice(0, limit);
    const ids = list.map((n) => n.id);
    // edges to the nodes already loaded too (the client sends them back as `offset` grows)
    const edges: GraphData["edges"] = ids.length
      ? await tx<GraphData["edges"]>`
          select src_page as "from", dst_page as "to", min(kind) as kind from links
          where vault_id = any(${vaults}) and dst_page is not null and src_page <> dst_page
            and (src_page = any(${ids}) or dst_page = any(${ids}))
          group by 1, 2
          limit 20000`
      : [];
    // links between vaults (unresolved in the store, see pageNames), when both ends are loaded
    if (ids.length && vaults.length > 1) {
      const cross = await tx<GraphData["edges"]>`
        select distinct l.src_page as "from", a.page_id as "to", 'wikilink' as kind, true as cross
        from links l join aliases a on a.alias_norm = l.target_norm and a.vault_id = any(${vaults}) and a.vault_id <> l.vault_id
        where l.vault_id = any(${vaults}) and l.dst_page is null and l.src_page = any(${ids}) and a.page_id = any(${ids})
        limit 20000`;
      edges.push(...cross);
    }
    return { nodes: list, edges, more };
  });
}

/** Chunks of a source in reading order (source view). */
export async function sourceChunks(sql: Sql, p: Principal, sourceId: string, o: { offset?: number; limit?: number } = {}) {
  return withReader(sql, p, (tx) => tx<{ id: string; ord: number; heading: string | null; text: string; tokens: number }[]>`
    select id, ord, heading, text, tokens from chunks
    where vault_id = any(${p.vaults}) and source_id = ${sourceId}
    order by ord offset ${Math.max(o.offset ?? 0, 0)} limit ${Math.min(o.limit ?? 200, 1000)}`);
}
