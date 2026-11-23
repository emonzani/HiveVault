/**
 * Pages of the compiled wiki (L2/L3): write path for the system (ingestion, dream cycle,
 * import, editors) and read helpers for the reader role.
 *
 * One `upsert` writes, in one transaction: the page, its previous version, title and aliases,
 * blocks, outgoing links (resolved now or later), the links of other pages that were waiting
 * for this title, the search chunks (keeping the embeddings of unchanged text) and the vault
 * version (cache key).
 */
import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "@cb/db";
import { estimateTokens, newId } from "@cb/shared";
import { classificationLevel, isPersonalOwner, PERSONAL, PersonalClassificationError, visibilityLevel } from "./access.ts";
import { chunkMarkdown, type ChunkOptions } from "./chunker.ts";
import { explicitBlocks, extractWikilinks, firstParagraph, normalizeTitle, parseDocument, sections, serializeDocument, slugify } from "./markdown.ts";
import { bumpVersion } from "./vaults.ts";

export interface Page {
  id: string;
  vaultId: string;
  path: string;
  title: string;
  type: string;
  tldr: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  visibility: number;
  classification: number;
  confidence: number | null;
  tokens: number;
  hash: string;
  version: number;
  updatedAt: Date;
}

export interface UpsertPage {
  vaultId: string;
  /** Full Markdown with frontmatter, or frontmatter + body separately. */
  markdown?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  /** Explicit id or path; else taken from the frontmatter, else from the title. */
  id?: string;
  path?: string;
  author?: string;
  /**
   * Write only when the page is still at this version (it read the page before): a page that
   * changed in between, or is gone, throws PageVersionError and keeps the newer text.
   */
  ifVersion?: number;
}

/** The page changed (or went) after the writer read it: `UpsertPage.ifVersion`. */
export class PageVersionError extends Error {}

export interface UpsertResult {
  page: Page;
  created: boolean;
  changed: boolean;
  chunks: number;
  linksResolved: number;
}

/** Page columns in camelCase, optionally qualified with a table alias. */
export function pageCols(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return [
    `${p}id`, `${p}vault_id as "vaultId"`, `${p}path`, `${p}title`, `${p}type`, `${p}tldr`, `${p}body`, `${p}frontmatter`,
    `${p}tags`, `${p}visibility`, `${p}classification`, `${p}confidence`, `${p}tokens`, `${p}hash`, `${p}version`,
    `${p}updated_at as "updatedAt"`,
  ].join(", ");
}
const PAGE_COLS = pageCols();

const DERIVED_KEYS = ["path", "tokens", "updated", "version"];
const pageKind = (type: string) => type.split("/")[0]!;
/**
 * The page a link `l` goes to: the page with that name in the vault. When a compiled page and
 * a source page share it ("ETSI EN 319 522-3"), the compiled page wins; then the title; then
 * the first page with the name. A resolved link moves only to a compiled page (upsert), not to
 * a newer page of the same kind, so "first" keeps old and new links on one page.
 */
const BEST_PAGE = `(select a.page_id from aliases a join pages p on p.id = a.page_id
  where a.vault_id = l.vault_id and a.alias_norm = l.target_norm
  order by split_part(p.type, '/', 1) = 'source', a.is_title desc, a.page_id limit 1)`;
const TYPE_PREFIX: Record<string, string> = { entity: "ent", concept: "cpt", decision: "dec", source: "spg", synthesis: "syn", note: "pag" };
const TYPE_FOLDER: Record<string, string> = { entity: "entities", concept: "concepts", decision: "decisions", source: "sources", synthesis: "syntheses", note: "notes" };

export function pageFolder(type: string): string {
  return TYPE_FOLDER[type.split("/")[0]!] ?? "notes";
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export class PageStore {
  constructor(
    private readonly sql: Sql,
    private readonly chunkOptions: ChunkOptions = {},
  ) {}

  async upsert(input: UpsertPage): Promise<UpsertResult> {
    const doc = input.markdown !== undefined ? parseDocument(input.markdown) : { frontmatter: input.frontmatter ?? {}, body: input.body ?? "" };
    const fm = { ...doc.frontmatter };
    const body = doc.body.replace(/\r\n/g, "\n");
    const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const title = String(fm.title ?? h1 ?? input.path?.split("/").pop()?.replace(/\.md$/, "") ?? "").trim();
    if (!title) throw new Error("a page needs a title (frontmatter title, a # heading or a path)");
    const type = String(fm.type ?? "note");
    const aliases = asStringArray(fm.aliases);
    const tags = asStringArray(fm.tags);
    const tldr = String(fm.tldr ?? firstParagraph(body));

    return this.sql.begin(async (tx) => {
      const [vault] = await tx<{ defaultClassification: number; owner: string | null }[]>`
        select default_classification as "defaultClassification", owner from vaults where id = ${input.vaultId} for update`;
      if (!vault) throw new Error(`vault ${input.vaultId} not found`);
      const classification = classificationLevel(fm.classification, vault.defaultClassification);
      if (classification === PERSONAL && !isPersonalOwner(vault.owner)) throw new PersonalClassificationError();
      const visibility = visibilityLevel(fm.visibility, 2);
      const confidence = typeof fm.confidence === "number" ? fm.confidence : null;

      // Identity: explicit id > frontmatter id > existing page at the path > new id
      const path = input.path ?? (typeof fm.path === "string" ? fm.path : `${pageFolder(type)}/${slugify(title)}.md`);
      // An explicit id must belong to this vault. A frontmatter id identifies the page only in
      // its own vault: in another vault (an export imported elsewhere) the page is a copy.
      let wantedId = input.id ?? (typeof fm.id === "string" ? fm.id : undefined);
      let [existing] = wantedId ? await tx<Page[]>`select ${tx.unsafe(PAGE_COLS)} from pages where id = ${wantedId}` : [];
      if (existing && existing.vaultId !== input.vaultId) {
        if (input.id) throw new Error(`page ${existing.id} belongs to another vault`);
        existing = undefined;
        wantedId = undefined;
      }
      if (!existing && !input.id) {
        [existing] = await tx<Page[]>`select ${tx.unsafe(PAGE_COLS)} from pages where vault_id = ${input.vaultId} and path = ${path}`;
      }
      if (input.ifVersion !== undefined && existing?.version !== input.ifVersion) {
        throw new PageVersionError(`page ${input.id ?? path} is not at version ${input.ifVersion}`);
      }
      const id = existing?.id ?? wantedId ?? newId(TYPE_PREFIX[type.split("/")[0]!] ?? "pag");

      const stored: Record<string, unknown> = { ...fm, id, title, type };
      // values computed by the server (written by the export) are not stored
      for (const k of DERIVED_KEYS) delete stored[k];
      // canonical form: key order in the frontmatter must not change the hash
      const canonical = Object.fromEntries(Object.entries(stored).sort(([a], [b]) => a.localeCompare(b)));
      const hash = createHash("sha256").update(serializeDocument(canonical, body)).digest("hex");
      if (existing && existing.hash === hash && existing.path === path) {
        return { page: existing, created: false, changed: false, chunks: 0, linksResolved: 0 };
      }
      const tokens = estimateTokens(body);

      let rows: Page[];
      if (existing) {
        // the version keeps the classification it had: lowering the page does not lower its history
        await tx`
          insert into page_versions (page_id, version, title, body, frontmatter, hash, author, classification)
          values (${existing.id}, ${existing.version}, ${existing.title}, ${existing.body}, ${tx.json(existing.frontmatter as never)},
                  ${existing.hash}, ${input.author ?? null}, ${existing.classification})
          on conflict do nothing`;
        rows = await tx<Page[]>`
          update pages set path = ${path}, title = ${title}, type = ${type}, tldr = ${tldr}, body = ${body},
                 frontmatter = ${tx.json(stored as never)}, tags = ${tags}, visibility = ${visibility},
                 classification = ${classification}, confidence = ${confidence}, tokens = ${tokens}, hash = ${hash},
                 version = version + 1, updated_at = now()
          where id = ${id} returning ${tx.unsafe(PAGE_COLS)}`;
      } else {
        rows = await tx<Page[]>`
          insert into pages (id, vault_id, path, title, type, tldr, body, frontmatter, tags, visibility, classification, confidence, tokens, hash)
          values (${id}, ${input.vaultId}, ${path}, ${title}, ${type}, ${tldr}, ${body}, ${tx.json(stored as never)}, ${tags},
                  ${visibility}, ${classification}, ${confidence}, ${tokens}, ${hash})
          returning ${tx.unsafe(PAGE_COLS)}`;
      }
      const page = rows[0]!;

      // Title and aliases
      const names = [...new Map([[normalizeTitle(title), true], ...aliases.map((a) => [normalizeTitle(a), false] as [string, boolean])]).entries()].filter(([n]) => n);
      await tx`delete from aliases where page_id = ${id}`;
      for (const [alias, isTitle] of names) {
        await tx`insert into aliases (vault_id, alias_norm, page_id, is_title) values (${input.vaultId}, ${alias}, ${id}, ${isTitle}) on conflict do nothing`;
      }

      // Blocks: sections + explicit ^ids
      await tx`delete from blocks where page_id = ${id}`;
      const blockRows = [
        ...sections(body).map((s) => ({ page_id: id, block_id: s.id, heading_path: s.headingPath, start_offset: s.headingStart, end_offset: s.end, tokens: estimateTokens(body.slice(s.headingStart, s.end)) })),
        ...explicitBlocks(body).map((b) => ({ page_id: id, block_id: b.id, heading_path: [] as string[], start_offset: b.start, end_offset: b.end, tokens: estimateTokens(body.slice(b.start, b.end)) })),
      ];
      if (blockRows.length) await tx`insert into blocks ${tx(blockRows)} on conflict do nothing`;

      // Outgoing links, resolved by title/alias in the same vault
      await tx`delete from links where src_page = ${id}`;
      const links = extractWikilinks(body);
      if (links.length) {
        const rows = links.map((l, ord) => ({
          src_page: id,
          vault_id: input.vaultId,
          ord,
          target_raw: l.raw,
          target_norm: normalizeTitle(l.target),
          anchor: l.anchor,
          kind: l.embed ? "embed" : "wikilink",
        }));
        await tx`insert into links ${tx(rows)}`;
        await tx`update links l set dst_page = ${tx.unsafe(BEST_PAGE)} where l.src_page = ${id}`;
      }
      // Links of other pages on a name this page no longer has: to the page with that name, or waiting
      await tx`
        update links l set dst_page = ${tx.unsafe(BEST_PAGE)}
        where l.dst_page = ${id} and l.src_page <> ${id} and l.target_norm <> all(${names.map(([n]) => n)})`;
      // Links of other pages that were waiting for one of these names (index links_unresolved_idx)
      const norms = names.map(([n]) => n);
      const resolved = await tx`
        update links set dst_page = ${id}
        where vault_id = ${input.vaultId} and dst_page is null and target_norm = any(${norms})`;
      // A compiled page also takes the links that went to a source page on the same name
      if (pageKind(type) !== "source") {
        await tx`
          update links l set dst_page = ${id}
          where l.dst_page in (select a.page_id from aliases a join pages d on d.id = a.page_id
                               where a.vault_id = ${input.vaultId} and a.alias_norm = any(${norms}) and split_part(d.type, '/', 1) = 'source')
            and l.target_norm = any(${norms})`;
      }

      const chunks = await this.writeChunks(tx, page, body, classification);
      await bumpVersion(tx, input.vaultId);
      return { page, created: !existing, changed: true, chunks, linksResolved: resolved.count };
    }) as Promise<UpsertResult>;
  }

  /** Replaces the chunks of a page. Embeddings of unchanged text (same hash) are kept. */
  private async writeChunks(tx: TransactionSql, page: Page, body: string, classification: number): Promise<number> {
    const old = await tx<{ hash: string; embedding: string | null; embedding_model: string | null }[]>`
      delete from chunks where vault_id = ${page.vaultId} and page_id = ${page.id}
      returning hash, embedding::text as embedding, embedding_model`;
    const kept = new Map(old.filter((o) => o.embedding).map((o) => [o.hash, o]));
    const chunks = chunkMarkdown(body, this.chunkOptions);
    if (chunks.length === 0) return 0;
    const rows = chunks.map((c) => {
      const hash = createHash("sha256").update(c.text).digest("hex");
      const k = kept.get(hash);
      return {
        vault_id: page.vaultId,
        id: `${page.id}:${c.ord}`,
        page_id: page.id,
        block_id: c.blockId,
        heading: c.heading,
        ord: c.ord,
        text: c.text,
        tokens: c.tokens,
        hash,
        classification,
        embedding: k?.embedding ?? null,
        embedding_model: k?.embedding_model ?? null,
      };
    });
    for (let i = 0; i < rows.length; i += 500) await tx`insert into chunks ${tx(rows.slice(i, i + 500))}`;
    return rows.length;
  }

  /**
   * Deletes a page. Links to it go to another page with the same name (the document of a
   * deleted concept page), or become unresolved again (they wait for a new page).
   */
  async delete(id: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const names = (await tx<{ n: string }[]>`select alias_norm as n from aliases where page_id = ${id}`).map((r) => r.n);
      const [p] = await tx<{ vault_id: string }[]>`delete from pages where id = ${id} returning vault_id`;
      if (!p) return false;
      if (names.length) {
        await tx`
          update links l set dst_page = ${tx.unsafe(BEST_PAGE)}
          where l.vault_id = ${p.vault_id} and l.dst_page is null and l.target_norm = any(${names})`;
      }
      await tx`delete from chunks where vault_id = ${p.vault_id} and page_id = ${id}`;
      await bumpVersion(tx, p.vault_id);
      return true;
    }) as Promise<boolean>;
  }

  // ---------------------------------------------------------------------------
  // Reads (pass a reader transaction from withReader for user-facing reads)
  // ---------------------------------------------------------------------------

  static async get(tx: Sql | TransactionSql, id: string): Promise<Page | undefined> {
    const [p] = await tx<Page[]>`select ${tx.unsafe(PAGE_COLS)} from pages where id = ${id}`;
    return p;
  }

  /** Resolves a title or alias in the given vaults (exact normalized match), in a fixed order. */
  static async resolve(tx: Sql | TransactionSql, vaultIds: string[], titleOrAlias: string): Promise<Page[]> {
    return tx<Page[]>`
      select ${tx.unsafe(pageCols("p"))}
      from aliases a join pages p on p.id = a.page_id
      where a.vault_id = any(${vaultIds}) and a.alias_norm = ${normalizeTitle(titleOrAlias)}
      order by split_part(p.type, '/', 1) = 'source', a.is_title desc, p.importance desc, p.id`;
  }

  static async backlinks(tx: Sql | TransactionSql, pageId: string): Promise<{ id: string; title: string; vaultId: string; anchor: string | null }[]> {
    return tx`
      select distinct on (p.id) p.id, p.title, p.vault_id as "vaultId", l.anchor
      from links l join pages p on p.id = l.src_page
      where l.dst_page = ${pageId} and l.src_page <> ${pageId}
      order by p.id`;
  }

  static async outlinks(tx: Sql | TransactionSql, pageId: string): Promise<{ target: string; anchor: string | null; kind: string; id: string | null; title: string | null }[]> {
    return tx`
      select l.target_raw as target, l.anchor, l.kind, p.id, p.title
      from links l left join pages p on p.id = l.dst_page
      where l.src_page = ${pageId} order by l.ord`;
  }

  static async versions(tx: Sql | TransactionSql, pageId: string): Promise<{ version: number; title: string; hash: string; author: string | null; createdAt: Date }[]> {
    return tx`
      select version, title, hash, author, created_at as "createdAt" from page_versions where page_id = ${pageId} order by version desc`;
  }
}
