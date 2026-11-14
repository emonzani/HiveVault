/**
 * Reading for the cloud agent (plan §6.2): a page cut to a token budget, never a 20k-token dump.
 *
 * Fill order: title + tldr → "Stato attuale" (compiled truth) → sections that match the
 * query → the most recent lines of "Timeline" → the other sections in page order.
 * Sections left out are listed with their token cost, so the caller can ask for them by id.
 */
import type { Sql, TransactionSql } from "@cb/db";
import { estimateTokens } from "@cb/shared";
import { withReader, type Principal } from "./access.ts";
import { sections } from "./markdown.ts";
import { PageStore, type Page } from "./pages.ts";
import { queryTerms } from "./search.ts";

export interface ReadOptions {
  /** Section ids to read (e.g. ["timeline"]); default: automatic by budget. */
  sections?: string[];
  maxTokens?: number;
  /** Ranks the optional sections by relevance to this text. */
  query?: string;
}

export interface ReadSection {
  id: string;
  title: string;
  tokens: number;
}

export interface ReadResult {
  id: string;
  vaultId: string;
  title: string;
  type: string;
  tldr: string;
  classification: number;
  version: number;
  updatedAt: Date;
  /** Tokens of the whole page body. */
  tokens: number;
  /** Markdown returned, within the budget. */
  content: string;
  contentTokens: number;
  truncated: boolean;
  included: ReadSection[];
  omitted: ReadSection[];
  backlinks: number;
}

const CURRENT = /^(stato attuale|stato|current state|summary|sintesi)$/i;
const TIMELINE = /^(timeline|cronologia|storia|history)$/i;

export async function readPage(sql: Sql, p: Principal, idOrTitle: string, opts: ReadOptions = {}): Promise<ReadResult | undefined> {
  return withReader(sql, p, async (tx) => {
    const page = (await PageStore.get(tx, idOrTitle)) ?? (await PageStore.resolve(tx, p.vaults, idOrTitle))[0];
    if (!page) return undefined;
    const [{ n }] = (await tx`select count(distinct src_page)::int as n from links where dst_page = ${page.id} and src_page <> ${page.id}`) as unknown as [{ n: number }];
    return cut(page, opts, n);
  });
}

export function cut(page: Page, opts: ReadOptions, backlinks = 0): ReadResult {
  const budget = opts.maxTokens ?? 2000;
  const body = page.body;
  const secs = sections(body);
  const pieces = secs.map((s, order) => {
    const text = body.slice(s.headingStart, s.end).trimEnd();
    return { s, order, text, tokens: estimateTokens(text) };
  });
  const header = `# ${page.title}\n\n> ${page.tldr}\n`;
  let used = estimateTokens(header);
  const chosen = new Set<number>();
  const partial = new Map<number, string>();

  const take = (i: number): boolean => {
    const pc = pieces[i]!;
    if (chosen.has(i)) return true;
    if (used + pc.tokens <= budget) {
      chosen.add(i);
      used += pc.tokens;
      return true;
    }
    return false;
  };

  if (opts.sections?.length) {
    const want = new Set(opts.sections.map((x) => x.toLowerCase()));
    pieces.forEach((pc, i) => (want.has(pc.s.id) || want.has(pc.s.title.toLowerCase())) && take(i));
  } else {
    // 1. compiled truth (or, if the page has none, the intro)
    const current = pieces.findIndex((pc) => CURRENT.test(pc.s.title));
    const first = current >= 0 ? current : pieces.findIndex((pc) => pc.s.level <= 1);
    if (first >= 0) take(first);
    // 2. sections matching the query
    const terms = opts.query ? queryTerms(opts.query) : [];
    if (terms.length) {
      const scored = pieces
        .map((pc, i) => {
          const norm = pc.text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
          return { i, hits: terms.reduce((n, t) => n + (norm.split(t).length - 1), 0) };
        })
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      for (const x of scored) take(x.i);
    }
    // 3. timeline: as many of the most recent lines as fit (newest first by convention)
    const tl = pieces.findIndex((pc) => TIMELINE.test(pc.s.title));
    if (tl >= 0 && !take(tl)) {
      const lines = pieces[tl]!.text.split("\n");
      let acc = lines[0]!; // the heading
      for (const line of lines.slice(1)) {
        const t = estimateTokens(acc + "\n" + line);
        if (used + t > budget) break;
        acc += "\n" + line;
      }
      if (acc !== lines[0]) {
        partial.set(tl, acc + "\n…");
        used += estimateTokens(acc);
      }
    }
    // 4. everything else in page order
    pieces.forEach((_, i) => take(i));
  }

  const ordered = pieces.filter((_, i) => chosen.has(i) || partial.has(i));
  const content = header + "\n" + ordered.map((pc) => partial.get(pc.order) ?? pc.text).join("\n\n");
  const included = ordered.map((pc) => ({ id: pc.s.id, title: pc.s.title, tokens: pc.tokens }));
  const omitted = pieces.filter((pc, i) => !chosen.has(i)).map((pc) => ({ id: pc.s.id, title: pc.s.title, tokens: pc.tokens }));
  return {
    id: page.id,
    vaultId: page.vaultId,
    title: page.title,
    type: page.type,
    tldr: page.tldr,
    classification: page.classification,
    version: page.version,
    updatedAt: page.updatedAt,
    tokens: page.tokens,
    content,
    contentTokens: estimateTokens(content),
    truncated: omitted.length > 0 || partial.size > 0,
    included,
    omitted,
    backlinks,
  };
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  vaultId: string;
  depth: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

/** Breadth-first neighborhood (both directions) up to `depth` hops, at most `maxNodes` nodes. */
export async function neighbors(sql: Sql, p: Principal, pageId: string, depth = 1, maxNodes = 50): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  return withReader(sql, p, async (tx: TransactionSql) => {
    const start = await PageStore.get(tx, pageId);
    if (!start) return { nodes: [], edges: [] };
    const nodes = new Map<string, GraphNode>([[start.id, { id: start.id, title: start.title, type: start.type, vaultId: start.vaultId, depth: 0 }]]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [start.id];
    for (let d = 1; d <= Math.min(depth, 3) && frontier.length && nodes.size < maxNodes; d++) {
      const rows = await tx<{ src: string; dst: string; kind: string }[]>`
        select src_page as src, dst_page as dst, kind from links
        where dst_page is not null and src_page <> dst_page and (src_page = any(${frontier}) or dst_page = any(${frontier}))
        union
        -- links between vaults stay unresolved in the store: match them on title and aliases
        select l.src_page as src, a.page_id as dst, l.kind from links l
        join aliases a on a.alias_norm = l.target_norm and a.vault_id = any(${p.vaults}) and a.vault_id <> l.vault_id
        where l.vault_id = any(${p.vaults}) and l.dst_page is null and (l.src_page = any(${frontier}) or a.page_id = any(${frontier}))`;
      const next: string[] = [];
      for (const r of rows) {
        edges.set(`${r.src}>${r.dst}>${r.kind}`, { from: r.src, to: r.dst, kind: r.kind });
        for (const id of [r.src, r.dst]) if (!nodes.has(id) && !next.includes(id)) next.push(id);
      }
      const fresh = next.slice(0, maxNodes - nodes.size);
      if (fresh.length) {
        const ps = await tx<{ id: string; title: string; type: string; vaultId: string }[]>`
          select id, title, type, vault_id as "vaultId" from pages where id = any(${fresh})`;
        for (const x of ps) nodes.set(x.id, { ...x, depth: d });
      }
      frontier = fresh.filter((id) => nodes.has(id));
    }
    // edges only between visible nodes (RLS hides pages of other vaults or higher classification)
    return { nodes: [...nodes.values()], edges: [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to)) };
  });
}
