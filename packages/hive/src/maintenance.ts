/**
 * Vault maintenance used by the dream cycle (plan §5): duplicate pages, unlinked mentions,
 * lint, importance, generated indexes, database upkeep. Every function is idempotent: run
 * twice, it changes nothing the second time.
 */
import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "@cb/db";
import { createLogger } from "@cb/shared";
import { CLASSIFICATIONS, PERSONAL, classificationLevel, documentCodes, maskCode, normalizeTitle, pageFolder, PageStore, PageVersionError, shortForms, type Page } from "@cb/brain";
import { claimHash, NOTE } from "./claims.ts";
import { NameAutomaton } from "./matcher.ts";
import { upsertCuratorItem } from "./promote.ts";

const log = createLogger("maintenance");

/** Folders whose pages people and the compiler write (hive and source pages are rebuilt). */
const EDITABLE = ["entity", "concept", "decision", "synthesis", "note"];
const notGenerated = (alias = "") => `not (${alias}frontmatter ? 'hive_subject') and split_part(${alias}type, '/', 1) <> 'source' and ${alias}path not like '\\_inbox/%'`;

// ---------------------------------------------------------------------------
// Duplicates (step 3)
// ---------------------------------------------------------------------------

const LEGAL = /\b(s ?p ?a|s ?r ?l ?s?|s ?n ?c|s ?a ?s|ltd|inc|gmbh|llc|co)\b/g;
/** "ACME S.p.A." and "Acme spa" have the same key. */
export function entityKey(title: string): string {
  return normalizeTitle(title).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
}

/**
 * Titles with different numbers name different things, however similar the text: parts of a
 * standard ("ETSI EN 319 522-1" and "-4-1"), articles, versions. They are never duplicates.
 */
export function sameNumbers(a: string, b: string): boolean {
  const nums = (t: string) => (t.match(/\d+/g) ?? []).join(" ");
  return nums(a) === nums(b);
}

export interface DuplicatePair {
  a: { id: string; title: string; tldr: string };
  b: { id: string; title: string; tldr: string };
  similarity: number;
  /** Same key after removing the legal form: merged without asking. */
  certain: boolean;
}

/** Pairs of pages of the same folder with similar titles (trigram), in id order after `after`. */
export async function findDuplicates(sql: Sql, vaultId: string, o: { after?: string; limit?: number; threshold?: number } = {}): Promise<{ pairs: DuplicatePair[]; next: string | null }> {
  const limit = o.limit ?? 100;
  const pagesBatch = await sql<{ id: string; title: string; type: string; tldr: string }[]>`
    select id, title, type, tldr from pages
    where vault_id = ${vaultId} and ${sql.unsafe(notGenerated())} and id > ${o.after ?? ""}
      and classification <> ${PERSONAL} -- a pair goes to the curator queue, which administrators read
    order by id limit ${limit}`;
  const pairs: DuplicatePair[] = [];
  // set_limit is per connection: the threshold and the queries share one transaction
  await sql.begin(async (tx) => {
    await tx`select set_limit(${o.threshold ?? 0.55})`;
    for (const p of pagesBatch) {
      const similar = await tx<{ id: string; title: string; tldr: string; s: number }[]>`
        select id, title, tldr, similarity(title, ${p.title}) as s from pages
        where vault_id = ${vaultId} and id > ${p.id} and title % ${p.title}
          and split_part(type, '/', 1) = ${p.type.split("/")[0]!} and ${tx.unsafe(notGenerated())}
          and classification <> ${PERSONAL}
        order by s desc limit 5`;
      for (const q of similar) {
        if (!sameNumbers(p.title, q.title)) continue;
        pairs.push({ a: { id: p.id, title: p.title, tldr: p.tldr }, b: { id: q.id, title: q.title, tldr: q.tldr }, similarity: q.s, certain: entityKey(p.title) === entityKey(q.title) });
      }
    }
  });
  return { pairs, next: pagesBatch.length === limit ? pagesBatch.at(-1)!.id : null };
}

/** A frontmatter list: `aliases: X` in YAML is one string, not a list of letters. */
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? [v] : []);

/** The merge would move the text of a private page into a page that is not private. */
export class MergeVisibilityError extends Error {}

/**
 * Merges `dropId` into `keepId`: the kept page gets the other title as alias and its sections
 * under "Unito da «…»"; the other page goes. Links to the removed page become unresolved and
 * resolve again on the alias in the same write, so no link breaks. A private page is never
 * merged into a page that is not private (MergeVisibilityError, nothing written): its text
 * would take the visibility of the kept page and be promoted (invariant 15).
 */
export async function mergePages(sql: Sql, pages: PageStore, keepId: string, dropId: string, author = "dream:dedup"): Promise<{ kept: string; removed: string; relinked: number }> {
  const keep = await PageStore.get(sql, keepId);
  const drop = await PageStore.get(sql, dropId);
  if (!keep || !drop || keep.vaultId !== drop.vaultId) throw new Error("pages to merge not found in the same vault");
  if (drop.visibility === 0 && keep.visibility !== 0) {
    throw new MergeVisibilityError("La pagina da rimuovere è privata e quella da tenere no: tieni la pagina privata o dai alle due pagine la stessa visibilità prima di unirle.");
  }
  const aliases = new Set<string>([
    ...list(keep.frontmatter.aliases),
    drop.title,
    ...list(drop.frontmatter.aliases),
  ]);
  aliases.delete(keep.title);
  const dropBody = drop.body.replace(/^\s*#\s+[^\n]*\n+/, "").trim();
  const body = dropBody && !keep.body.includes(dropBody) ? `${keep.body.trimEnd()}\n\n## Unito da «${drop.title}»\n\n${dropBody.replace(/^(#{1,5}) /gm, "#$1 ")}\n` : keep.body;
  const sources = [...new Set([...list(keep.frontmatter.sources), ...list(drop.frontmatter.sources)])];
  await pages.delete(drop.id);
  const r = await pages.upsert({
    vaultId: keep.vaultId,
    id: keep.id,
    path: keep.path,
    // the merged text is as restricted as the more restricted page
    frontmatter: {
      ...keep.frontmatter,
      classification: CLASSIFICATIONS[Math.max(keep.classification, drop.classification)],
      aliases: [...aliases].sort(),
      ...(sources.length ? { sources } : {}),
      merged_from: [...list(keep.frontmatter.merged_from), drop.id],
    },
    body,
    author,
  });
  await sql`
    insert into vault_log (vault_id, kind, title, ref, data, classification)
    values (${keep.vaultId}, 'merge', ${`Unita «${drop.title}» in «${keep.title}»`.slice(0, 300)}, ${keep.id}, ${sql.json({ removed: drop.id })}, ${Math.max(keep.classification, drop.classification)})`;
  // other candidates with the removed page cannot be merged any more
  await sql`
    update curator_items set status = 'superseded'
    where kind = 'duplicate' and status = 'open' and (data->'a'->>'id' = ${drop.id} or data->'b'->>'id' = ${drop.id})
      and not (data->'a'->>'id' = any(${[keep.id, drop.id]}) and data->'b'->>'id' = any(${[keep.id, drop.id]}))`;
  return { kept: keep.id, removed: drop.id, relinked: r.linksResolved };
}

/** The page to keep: more backlinks, then older. */
export async function pickKeeper(sql: Sql, a: string, b: string): Promise<[keep: string, drop: string]> {
  const rows = await sql<{ id: string; n: number; created: Date }[]>`
    select p.id, (select count(*)::int from links l where l.dst_page = p.id) as n, p.created_at as created from pages p where p.id = any(${[a, b]})`;
  rows.sort((x, y) => y.n - x.n || x.created.getTime() - y.created.getTime() || x.id.localeCompare(y.id));
  return [rows[0]!.id, rows[1]!.id];
}

// ---------------------------------------------------------------------------
// Unlinked mentions → [[links]] (step 4)
// ---------------------------------------------------------------------------

export interface LinkTarget {
  /** Text as written in the pages (title or alias). */
  name: string;
  title: string;
  pageId: string;
  /**
   * What the link writes when it is not the title: the name of a source page. A compiled page
   * that takes the name later takes the link too (PageStore.upsert); a link to the long title
   * of the document would stay on the document.
   */
  link?: string;
  /** Classification of the target page; a target without one counts as the highest. */
  classification?: number;
}

const worthLinking = (n: string) => n.length >= 5 && (/^\p{Lu}/u.test(n) || n.includes(" "));
/**
 * A name a wikilink can carry (`WIKILINK` in @cb/brain): no `[ ] | # ^`, no final ".md" (the
 * parser drops it). File names of documents can have them: "Verbale [bozza].docx" would give a
 * link that never parses and is wrapped again every night.
 */
const linkable = (n: string) => !/[[\]|#^]/.test(n) && !/\.md$/i.test(n);

export interface TargetRow {
  id: string;
  title: string;
  aliases: string[] | null;
  /** A source page: linked only on names that no compiled page has. */
  source?: boolean;
  classification?: number;
}

/**
 * Picks the link targets from the titles and aliases of the pages. A name of two pages is
 * ambiguous and not linked. Short forms of standards come after: an explicit name of another
 * page wins, and a short form of two pages is dropped. Source pages come last, on the names
 * left free by the compiled pages (a standard with only its document, no concept page yet).
 */
export function pickTargets(all: TargetRow[]): { targets: LinkTarget[]; ambiguous: number } {
  const compiled = pickTier(all.filter((r) => !r.source), new Set());
  const sources = pickTier(all.filter((r) => r.source), compiled.taken);
  return { targets: [...compiled.targets, ...sources.targets].sort((a, b) => b.name.length - a.name.length), ambiguous: compiled.ambiguous + sources.ambiguous };
}

/** Targets of one tier of pages; names in `taken` belong to a tier before. */
function pickTier(rows: TargetRow[], taken: Set<string>): { targets: LinkTarget[]; ambiguous: number; taken: Set<string> } {
  // `stored`: the names are aliases in the database, so a link can write them
  const collect = (namesOf: (r: TargetRow) => string[], stored: boolean) => {
    const byName = new Map<string, LinkTarget[]>();
    for (const r of rows) {
      for (const name of namesOf(r)) {
        const n = name.trim();
        const link = stored && r.source && n !== r.title ? n : undefined;
        if (!worthLinking(n) || !linkable(n) || !linkable(link ?? r.title)) continue;
        const k = n.toLowerCase();
        const list = byName.get(k) ?? [];
        if (!list.some((t) => t.pageId === r.id)) list.push({ name: n, title: r.title, pageId: r.id, ...(link ? { link } : {}), ...(r.classification !== undefined ? { classification: r.classification } : {}) });
        byName.set(k, list);
      }
    }
    return byName;
  };
  const explicit = collect((r) => [r.title, ...(r.aliases ?? [])], true);
  const short = collect((r) => [r.title, ...(r.aliases ?? [])].flatMap(shortForms), false);
  let ambiguous = 0;
  const targets: LinkTarget[] = [];
  for (const [k, list] of explicit) {
    if (taken.has(k)) continue;
    if (list.length === 1) targets.push(list[0]!);
    else ambiguous++;
  }
  for (const [k, list] of short) if (list.length === 1 && !explicit.has(k) && !taken.has(k)) targets.push(list[0]!);
  return { targets, ambiguous, taken: new Set([...explicit.keys(), ...short.keys()]) };
}

/** The targets of a vault with the automaton of their names (M11): built once per pass. */
export interface TargetIndex {
  targets: LinkTarget[];
  ambiguous: number;
  automaton: NameAutomaton;
}

export function targetIndex(t: { targets: LinkTarget[]; ambiguous: number }): TargetIndex {
  return { ...t, automaton: new NameAutomaton(t.targets.map((x) => x.name)) };
}

/**
 * Targets of the passes in progress, by vault and start of the pass. A pass changes only the
 * bodies of pages (links), never titles or aliases: its targets stay valid for all its batches.
 * After a restart the next batch loads them again. An automaton of 50 000 names takes about
 * 40 MB: a pass drops its entry when it ends, and at most 4 passes keep one.
 */
const passTargets = new Map<string, TargetIndex>();

async function targetsOfPass(sql: Sql, vaultId: string, pass: string): Promise<TargetIndex> {
  const key = `${vaultId}|${pass}`;
  const hit = passTargets.get(key);
  if (hit) return hit;
  const t = targetIndex(await linkTargets(sql, vaultId));
  passTargets.set(key, t);
  while (passTargets.size > 4) passTargets.delete(passTargets.keys().next().value!);
  return t;
}

/** Names worth linking in a vault: titles and aliases of its pages, and their short forms. */
export async function linkTargets(sql: Sql, vaultId: string): Promise<{ targets: LinkTarget[]; ambiguous: number }> {
  const rows = await sql<TargetRow[]>`
    select id, title, case when jsonb_typeof(frontmatter->'aliases') = 'array' then array(select jsonb_array_elements_text(frontmatter->'aliases')) end as aliases,
           split_part(type, '/', 1) = 'source' as source, classification
    from pages where vault_id = ${vaultId} and path not like '\\_inbox/%' and classification <> ${PERSONAL}`;
  return pickTargets(rows);
}

/**
 * Gives every source page of the vault the code of its document as alias ("EN 319 522-2",
 * "ETSI EN 319 522-2"), so that links written with the code find the document. New sources
 * get them from the compiler; this is for the pages compiled before. Idempotent. With `since`,
 * only the source pages changed since then (M11): the others were looked at by an earlier pass.
 */
export async function sourceCodeAliases(sql: Sql, pages: PageStore, vaultId: string, since: string | null = null): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    select id from pages where vault_id = ${vaultId} and split_part(type, '/', 1) = 'source'
      and (${since}::timestamptz is null or updated_at > ${since}::timestamptz)`;
  let changed = 0;
  for (const r of rows) {
    const page = await PageStore.get(sql, r.id);
    if (!page) continue;
    const aliases = list(page.frontmatter.aliases);
    const missing = documentCodes(page.title, page.body).filter((c) => !aliases.includes(c));
    if (!missing.length) continue;
    await pages.upsert({ vaultId, id: page.id, path: page.path, frontmatter: { ...page.frontmatter, aliases: [...aliases, ...missing] }, body: page.body, author: "dream:crosslink" });
    changed++;
  }
  return changed;
}

/** Names of the targets on pages written since the last night: older pages may mention them. */
export function newNames(targets: LinkTarget[], updated: { id: string }[]): string[] {
  const ids = new Set(updated.map((u) => u.id));
  return [...new Set(targets.filter((t) => ids.has(t.pageId)).map((t) => t.name))];
}

/** ILIKE pattern that finds `name` anywhere in a text. */
export const likeAny = (name: string) => `%${name.replace(/[\\%_]/g, "\\$&")}%`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turns the first unlinked mention of every target into a [[link]]. Text inside code, links,
 * citations, headings, callout titles and the page's own name is left alone. A link writes the
 * title of its target: targets classified above `ceiling` (the classification of the page) are
 * left out, as if they did not exist.
 */
export function crosslinkBody(
  body: string,
  selfId: string,
  targets: LinkTarget[],
  linked: Set<string>,
  max = 20,
  index?: TargetIndex,
  ceiling = PERSONAL,
): { body: string; added: number } {
  const allowed = (t: LinkTarget) => t.pageId !== selfId && !linked.has(t.pageId) && (t.classification ?? PERSONAL) <= ceiling;
  const candidates = targets.filter(allowed);
  if (!candidates.length) return { body, added: 0 };
  // positions that must not change: code, [[links]], [md](links), ^[citations], headings, callout markers
  let masked = maskCode(body);
  const blank = (re: RegExp) => (masked = masked.replace(re, (m) => " ".repeat(m.length)));
  blank(/!?\[\[[^\]\n]*\]\]/g);
  blank(/\^\[[^\]\n]*\]/g);
  blank(/\[[^\]\n]*\]\([^)\n]*\)/g);
  blank(/^#{1,6}[^\n]*$/gm);
  blank(/\[![a-z-]+\][^\n]*/gi);
  blank(/https?:\/\/\S+/g);
  const byLower = new Map(candidates.map((t) => [t.name.toLowerCase(), t]));
  const edits: { at: number; len: number; text: string }[] = [];
  const done = new Set<string>();
  for (const m of mentions(masked, candidates, index, allowed)) {
    const t = byLower.get(m[0].toLowerCase());
    if (!t || done.has(t.pageId)) continue;
    // case must match except for the first letter (sentence start)
    if (m[0].slice(1) !== t.name.slice(1)) continue;
    const original = body.slice(m.index!, m.index! + m[0].length);
    const dest = t.link ?? t.title;
    edits.push({ at: m.index!, len: m[0].length, text: original === dest ? `[[${dest}]]` : `[[${dest}|${original}]]` });
    done.add(t.pageId);
    if (edits.length >= max) break;
  }
  let out = body;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len);
  return { body: out, added: edits.length };
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The mentions of the candidates in a masked text, left to right, without overlaps, the longest
 * name first at one position: what the regular expression of the names finds. With the
 * automaton of a pass (M11) one scan finds them; else, or for a text whose lower case has
 * another length, the regular expression.
 */
function mentions(masked: string, candidates: LinkTarget[], index: TargetIndex | undefined, allowed: (t: LinkTarget) => boolean): { 0: string; index: number }[] {
  const lower = index ? NameAutomaton.lower(masked) : null;
  if (!index || lower === null) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${candidates.map((t) => escapeRe(t.name)).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
    return [...masked.matchAll(re)].map((m) => ({ 0: m[0], index: m.index! }));
  }
  const found = index.automaton
    .all(lower)
    .filter((m) => allowed(index.targets[m.pattern]!) && !WORD.test(masked[m.start - 1] ?? "") && !WORD.test(masked[m.start + m.length] ?? ""))
    .sort((a, b) => a.start - b.start || b.length - a.length);
  const out: { 0: string; index: number }[] = [];
  let pos = 0;
  for (const m of found) {
    if (m.start < pos) continue;
    out.push({ 0: masked.slice(m.start, m.start + m.length), index: m.start });
    pos = m.start + m.length;
  }
  return out;
}

/**
 * A time T such that every page with `updated_at <= T` is visible now. `updated_at` is the start
 * of the writing transaction, and a transaction can commit long after it (a page write waits
 * for the lock of its vault): the time stops at the start of the oldest open transaction.
 */
export async function safeNow(sql: Sql): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select least(now(), (select min(xact_start) from pg_stat_activity
                         where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null))::text as t`;
  return r!.t;
}

export interface CrosslinkCursor {
  after: string;
  aliases?: number;
  /** End of the names looked for (now, at the first batch). */
  names?: string;
  /** Every page written up to here is seen by this pass (`safeNow`): the next pass starts here. */
  until?: string;
}

/**
 * One batch of 100 pages of the crosslink: the pages changed since `since` (all pages without
 * it), and older pages that write a name new since then. Used by the dream cycle (step 4) and
 * by the link task during the day. `codeAliases` first gives the source pages the codes of
 * their documents (a look at every source page: the dream cycle only). A page that changes
 * while its links are added keeps the newer text and gets its links at the next pass.
 */
export async function crosslinkBatch(
  sql: Sql,
  pages: PageStore,
  vaultId: string,
  cursor: CrosslinkCursor | null,
  since: string | null,
  o: { codeAliases?: boolean } = {},
): Promise<{ done: boolean; cursor: CrosslinkCursor; report: Record<string, number> }> {
  const c = cursor ?? { after: "" };
  // first batch: the codes of the documents compiled before they were aliases (changed pages only)
  const aliases = c.after === "" && o.codeAliases ? await sourceCodeAliases(sql, pages, vaultId, since) : (c.aliases ?? 0);
  // the names new since the last pass stop at the first batch: the links this step adds
  // change pages too, and must not widen the next batches
  const names = c.names ?? (await sql<{ t: string }[]>`select now()::text as t`)[0]!.t;
  const until = c.until ?? (await safeNow(sql));
  // M11: the targets and their automaton once per pass (`names` names the pass)
  const index = await targetsOfPass(sql, vaultId, names);
  const { targets, ambiguous } = index;
  // pages changed since the last pass, and older pages that write a name new since then
  const fresh = since
    ? newNames(targets, await sql<{ id: string }[]>`
        select id from pages where vault_id = ${vaultId} and updated_at > ${since}::timestamptz and updated_at <= ${names}::timestamptz`)
    : [];
  const rescanAll = !since || fresh.length > 500;
  const rows = await sql<{ id: string }[]>`
    select id from pages
    where vault_id = ${vaultId} and split_part(type, '/', 1) = any(${[...EDITABLE, "source"]}) and not (frontmatter ? 'hive_subject') and path not like '\\_inbox/%'
      and (${rescanAll} or updated_at > ${since}::timestamptz or body ilike any(${fresh.map(likeAny)})) and id > ${c.after}
    order by id limit 100`;
  let added = 0;
  let changed = 0;
  let skipped = 0;
  const [vault] = await sql<{ dc: number }[]>`select default_classification as dc from vaults where id = ${vaultId}`;
  for (const r of rows) {
    const page = await PageStore.get(sql, r.id);
    if (!page) continue;
    const linked = new Set((await sql<{ dst: string }[]>`select dst_page as dst from links where src_page = ${page.id} and dst_page is not null`).map((x) => x.dst));
    // no title of a page classified above this one: its classification now, or the one this
    // write gives it (PageStore.upsert: the vault default when the frontmatter has none)
    const ceiling = Math.min(page.classification, classificationLevel(page.frontmatter.classification, vault?.dc ?? page.classification));
    const out = crosslinkBody(page.body, page.id, targets, linked, 20, index, ceiling);
    if (!out.added) continue;
    try {
      await pages.upsert({ vaultId, id: page.id, path: page.path, frontmatter: page.frontmatter, body: out.body, author: "dream:crosslink", ifVersion: page.version });
    } catch (e) {
      if (!(e instanceof PageVersionError)) throw e;
      skipped++;
      continue;
    }
    added += out.added;
    changed++;
  }
  if (rows.length < 100) passTargets.delete(`${vaultId}|${names}`);
  return {
    done: rows.length < 100,
    cursor: { after: rows.at(-1)?.id ?? c.after, aliases, names, until },
    report: { "link aggiunti": added, "pagine modificate": changed, ambigui: ambiguous, "codici dei documenti": aliases, ...(skipped ? { "cambiate nel frattempo": skipped } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Lint (step 5)
// ---------------------------------------------------------------------------

export interface LintReport {
  orphans: number;
  brokenLinks: number;
  stale: number;
  contradictions: number;
}

/**
 * Orphans, broken links, stale pages and contradictions between the claims of the vault.
 * Contradictions go to the curator queue of the vault; everything is listed in the page
 * "_inbox/manutenzione.md", rebuilt every night.
 */
export async function lintVault(sql: Sql, pages: PageStore, vaultId: string): Promise<LintReport> {
  const orphans = await sql<{ id: string; title: string; classification: number }[]>`
    select p.id, p.title, p.classification from pages p
    where p.vault_id = ${vaultId} and ${sql.unsafe(notGenerated("p."))}
      and split_part(p.type, '/', 1) = any(${EDITABLE})
      and p.created_at < now() - interval '7 days'
      and not exists (select 1 from links l where l.dst_page = p.id and l.src_page <> p.id)
    order by p.importance desc, p.title limit 500`;
  // unresolved links whose name exists in no vault
  const broken = await sql<{ src: string; title: string; target: string; classification: number }[]>`
    select distinct on (l.src_page, l.target_norm) l.src_page as src, p.title, l.target_raw as target, p.classification
    from links l join pages p on p.id = l.src_page
    where l.vault_id = ${vaultId} and l.dst_page is null
      and not exists (select 1 from aliases a where a.alias_norm = l.target_norm)
    order by l.src_page, l.target_norm limit 500`;
  // compiled pages older than one of their sources
  const stale = await sql<{ id: string; title: string; classification: number }[]>`
    select p.id, p.title, p.classification from pages p
    where p.vault_id = ${vaultId} and jsonb_typeof(p.frontmatter->'sources') = 'array'
      and exists (select 1 from sources s where s.vault_id = ${vaultId} and s.id in (select jsonb_array_elements_text(p.frontmatter->'sources'))
                  and s.updated_at > p.updated_at + interval '1 hour' and s.level >= 1)
    limit 500`;
  // the same subject and predicate with different values in the vault
  const contra = await sql<{ subject: string; subjectNorm: string; predicate: string; values: { value: string; valueNorm: string; pageId: string; blockId: string | null }[] }[]>`
    select min(subject) as subject, subject_norm as "subjectNorm", predicate,
           json_agg(json_build_object('value', value, 'valueNorm', value_norm, 'pageId', page_id, 'blockId', block_id) order by value_norm) as values
    from claims where vault_id = ${vaultId} and status = 'active' and predicate <> ${NOTE}
    group by subject_norm, predicate having count(distinct value_norm) > 1 limit 500`;
  for (const c of contra) {
    const fp = claimHash(`${vaultId}|${c.subjectNorm}|${c.predicate}|${[...new Set(c.values.map((v) => v.valueNorm))].sort().join("|")}`);
    await upsertCuratorItem(sql, vaultId, "conflict", fp, c.subjectNorm, c.predicate, {
      title: c.subject,
      predicate: c.predicate,
      values: [...new Map(c.values.map((v) => [v.valueNorm, { value: v.value, valueNorm: v.valueNorm, refs: [] as unknown[] }])).values()].map((g) => ({
        ...g,
        refs: c.values.filter((v) => v.valueNorm === g.valueNorm).map((v) => ({ pageId: v.pageId, blockId: v.blockId, vault: vaultId })),
      })),
      origin: "lint",
    });
  }

  const listed = [...orphans, ...broken, ...stale];
  const classification = listed.length ? Math.max(...listed.map((x) => x.classification)) : 0;
  const section = (title: string, lines: string[], empty: string) => [`## ${title}`, ...(lines.length ? lines : [`Nessuna: ${empty}.`]), ""];
  const md = [
    `---`,
    `title: Manutenzione del vault`,
    `type: note/maintenance`,
    `classification: ${CLASSIFICATIONS[classification]}`,
    `tags: ["manutenzione"]`,
    `tldr: "Controlli del ciclo notturno: ${orphans.length} orfane, ${broken.length} link rotti, ${stale.length} da aggiornare, ${contra.length} contraddizioni."`,
    `---`,
    `# Manutenzione del vault`,
    ``,
    `Pagina scritta dal ciclo notturno. Le contraddizioni sono anche nella coda dei curatori.`,
    ``,
    ...section("Pagine orfane", orphans.map((o) => `- [[${o.title}]]`), "ogni pagina ha almeno un link in entrata"),
    ...section("Link rotti", broken.map((b) => `- [[${b.title}]] → ${b.target.replace(/^\[\[|\]\]$/g, "")}`), "nessun link verso pagine inesistenti"),
    ...section("Pagine da aggiornare", stale.map((s) => `- [[${s.title}]] (una sorgente è più recente)`), "nessuna"),
    ...section("Contraddizioni", contra.map((c) => `- ${c.subject} · ${c.predicate}: ${[...new Set(c.values.map((v) => v.value))].join(" / ")}`), "nessuna"),
  ].join("\n");
  await pages.upsert({ vaultId, markdown: md, path: "_inbox/manutenzione.md", author: "dream:lint" });
  return { orphans: orphans.length, brokenLinks: broken.length, stale: stale.length, contradictions: contra.length };
}

// ---------------------------------------------------------------------------
// Importance (step 8)
// ---------------------------------------------------------------------------

/** importance = ln(1+backlinks) + 0.7·ln(1+reads in 30 days) + recency (half-life ~60 days). */
export async function updateImportance(sql: Sql, vaultId: string): Promise<number> {
  const r = await sql`
    with bl as (
      select dst_page as id, count(distinct src_page) as n from links where vault_id = ${vaultId} and dst_page is not null group by 1
    ), rd as (
      select resource as id, count(*) as n from audit_log
      where action = 'page.read' and at > now() - interval '30 days' and resource like any (array['ent\\_%', 'cpt\\_%', 'dec\\_%', 'syn\\_%', 'pag\\_%', 'spg\\_%'])
      group by 1
    ), score as (
      select p.id, round((ln(1 + coalesce(bl.n, 0)) + 0.7 * ln(1 + coalesce(rd.n, 0))
                         + exp(-extract(epoch from now() - p.updated_at) / 86400.0 / 90))::numeric, 4)::real as v
      from pages p left join bl on bl.id = p.id left join rd on rd.id = p.id
      where p.vault_id = ${vaultId}
    )
    update pages p set importance = s.v from score s where p.id = s.id and abs(p.importance - s.v) > 0.01`;
  return r.count;
}

// ---------------------------------------------------------------------------
// Indexes and llms.txt (step 9)
// ---------------------------------------------------------------------------

const FOLDER_TITLES: Record<string, string> = {
  entities: "Entità",
  concepts: "Concetti",
  decisions: "Decisioni",
  syntheses: "Sintesi",
  sources: "Sorgenti",
  notes: "Note",
};

/**
 * Catalog by category and llms.txt of the pages that `tx` can see; the most important pages
 * first, at most `perFolder` each. Run it inside `withReader` to get the view of one reader:
 * a reader never sees titles or summaries above its clearance.
 */
export async function renderIndexes(tx: Sql | TransactionSql, vaultId: string, perFolder = 500, withPersonal = true): Promise<{ index: string; llms: string; pages: number } | null> {
  const [vault] = await tx<{ name: string; slug: string }[]>`select name, slug from vaults where id = ${vaultId}`;
  if (!vault) return null;
  const rows = await tx<(Pick<Page, "id" | "title" | "type" | "tldr" | "tokens" | "classification"> & { rn: number; total: number })[]>`
    select * from (
      select id, title, type, tldr, tokens, classification,
             row_number() over (partition by split_part(type, '/', 1) order by importance desc, title) as rn,
             count(*) over (partition by split_part(type, '/', 1))::int as total
      from pages where vault_id = ${vaultId} and path not like '\\_inbox/%' and (${withPersonal} or classification <> ${PERSONAL})
    ) x where rn <= ${perFolder} order by type, rn`;
  type Row = (typeof rows)[number];
  const byFolder = new Map<string, Row[]>();
  for (const r of rows) byFolder.set(pageFolder(r.type), [...(byFolder.get(pageFolder(r.type)) ?? []), r]);
  const total = rows.length ? [...new Map(rows.map((r) => [pageFolder(r.type), r.total])).values()].reduce((a, b) => a + b, 0) : 0;
  const index = [`# Indice — ${vault.name}`, "", `${total} pagine.`, ""];
  const llms = [`# ${vault.name}`, "", `> Vault "${vault.slug}" di HiveVault: ${total} pagine, le più importanti per prime. Ogni voce: titolo, sintesi, costo di lettura.`, ""];
  for (const [folder, ps] of [...byFolder.entries()].sort()) {
    const title = FOLDER_TITLES[folder] ?? folder;
    const more = ps[0]!.total - ps.length;
    index.push(`## ${title}`, "", ...ps.map((p) => `- [[${p.title}]] — ${p.tldr || "(senza sintesi)"}`), ...(more > 0 ? [`- … altre ${more} pagine`] : []), "");
    llms.push(`## ${title}`, "", ...ps.map((p) => `- ${p.title} (${p.id}, ${p.tokens} token): ${p.tldr || p.type}`), ...(more > 0 ? [`- … altre ${more} pagine: usa la ricerca`] : []), "");
  }
  return { index: index.join("\n"), llms: llms.join("\n"), pages: total };
}

/**
 * Dream step 9: the indexes of the vault (every classification but "personale"), stored for
 * exports and administrators. Readers get `renderIndexes` under their own clearance instead.
 */
export async function buildIndexes(sql: Sql, vaultId: string, perFolder = 500): Promise<{ pages: number }> {
  const r = await renderIndexes(sql, vaultId, perFolder, false);
  if (!r) return { pages: 0 };
  for (const [name, content] of [["index", r.index], ["llms", r.llms]] as const) {
    await sql`
      insert into vault_indexes (vault_id, name, content, pages) values (${vaultId}, ${name}, ${content}, ${r.pages})
      on conflict (vault_id, name) do update set content = excluded.content, pages = excluded.pages, updated_at = now()
      where vault_indexes.content is distinct from excluded.content`;
  }
  return { pages: r.pages };
}

// ---------------------------------------------------------------------------
// Database upkeep and checks (steps 10, 11)
// ---------------------------------------------------------------------------

/** VACUUM (ANALYZE) of the vault's chunk partition when more than 10% of its rows are dead. */
export async function vacuumVault(sql: Sql, vaultId: string): Promise<{ partition: string; vacuumed: boolean; dead: number }> {
  const [v] = await sql<{ part: string }[]>`select chunks_partition as part from vaults where id = ${vaultId}`;
  if (!v || !/^[a-z0-9_]+$/.test(v.part)) return { partition: v?.part ?? "", vacuumed: false, dead: 0 };
  const [st] = await sql<{ live: number; dead: number; analyzed: Date | null }[]>`
    select n_live_tup::int as live, n_dead_tup::int as dead, greatest(last_analyze, last_autoanalyze) as analyzed
    from pg_stat_user_tables where relname = ${v.part}`;
  const dead = st?.dead ?? 0;
  if (st && dead > 1000 && dead > 0.1 * st.live) {
    await sql.unsafe(`vacuum (analyze) ${v.part}`);
    return { partition: v.part, vacuumed: true, dead };
  }
  if (st && (!st.analyzed || Date.now() - st.analyzed.getTime() > 7 * 86400_000)) await sql.unsafe(`analyze ${v.part}`);
  return { partition: v.part, vacuumed: false, dead };
}

/** Reads a sample of originals back from the encrypted store and checks their hash. */
export async function checkBlobs(sql: Sql, readBlob: (vaultId: string, sha: string) => Promise<Buffer>, vaultId: string, sample = 5): Promise<{ checked: number; failed: string[] }> {
  const rows = await sql<{ id: string; sha256: string }[]>`select id, sha256 from sources where vault_id = ${vaultId} order by random() limit ${sample}`;
  const failed: string[] = [];
  for (const r of rows) {
    try {
      const data = await readBlob(vaultId, r.sha256);
      if (createHash("sha256").update(data).digest("hex") !== r.sha256) failed.push(r.id);
    } catch {
      failed.push(r.id);
    }
  }
  return { checked: rows.length, failed };
}

export interface UpkeepOptions {
  /** Finished tasks. Default 30. */
  taskDays?: number;
  /** Security events of the audit log (logins, admin changes). Never below 183 (6 months). Default 400. */
  auditDays?: number;
  /** Read events of the audit log (page.read, search, ...). Default 30. */
  readDays?: number;
}

/** Minimum days of the security events (Garante, provvedimento 27/11/2008): the database refuses less. */
export const AUDIT_MIN_DAYS = 183;

/**
 * Global upkeep, once a night: finished tasks; audit rows beyond their retention (read events
 * and security events apart); failed logins older than the 24 hours the lockout looks at.
 * The head of the audit hash chain goes to the log, so a rewritten chain shows against it.
 */
export async function globalUpkeep(sql: Sql, o: UpkeepOptions = {}): Promise<{ tasks: number; audit: number; reads: number; failures: number; chain: { seq: number; hash: string | null } }> {
  const tasks = await sql`
    delete from tasks where status in ('done', 'cancelled', 'failed') and parent_id is null
      and coalesce(finished_at, updated_at) < now() - make_interval(days => ${o.taskDays ?? 30})`;
  const reads = await sql`delete from audit_log where seq is null and at < now() - make_interval(days => ${o.readDays ?? 30})`;
  // security events: only the oldest part of the hash chain goes, so the chain stays whole
  const cutoff = sql`now() - make_interval(days => ${Math.max(AUDIT_MIN_DAYS, o.auditDays ?? 400)})`;
  const audit = await sql`
    delete from audit_log where seq is not null and at < ${cutoff}
      and seq < coalesce((select min(seq) from audit_log where seq is not null and at >= ${cutoff}), (select seq from audit_chain_head))`; // the last row stays: it anchors the head
  const failures = await sql`delete from auth_failures where at < now() - interval '24 hours'`;
  const [head] = await sql<{ seq: string; hash: string | null }[]>`select seq::text, encode(hash, 'hex') as hash from audit_chain_head`;
  const chain = { seq: Number(head?.seq ?? 0), hash: head?.hash ?? null };
  log.info("audit chain head", chain);
  return { tasks: tasks.count, audit: audit.count, reads: reads.count, failures: failures.count, chain };
}

export { EDITABLE };
