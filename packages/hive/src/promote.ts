/**
 * Promotion cell → hive (plan §3.2). For one hive space:
 *
 * 1. The claims of the cells that feed the space (`hive_feeds`) are synced with their pages.
 *    Only pages with visibility "team" or "azienda" are promoted: a private page never leaves
 *    its cell.
 * 2. Pages of different cells about the same subject are grouped by title and aliases.
 * 3. For every predicate: one value → merged, with the number of sources; more values → a
 *    `> [!conflict]` block and an item in the curator queue. A curator decision (a value, a
 *    new value, or "both are valid") is applied at every later promotion, until the values
 *    change. Values from pages with low confidence are marked "da verificare" and queued.
 * 4. Every statement carries its provenance `^[page#block]`. The page is rebuilt from the
 *    active claims every time, so a statement retracted in a cell disappears from the hive.
 *
 * Hive pages live under `hive/` with `hive_subject` in the frontmatter; the writes are
 * idempotent (an unchanged page gets no new version).
 */
import type { Sql } from "@cb/db";
import { CLASSIFICATIONS, isMassChange, normalizeTitle, PageStore, slugify, VISIBILITIES } from "@cb/brain";
import { newId, metrics } from "@cb/shared";
import { claimHash, NOTE, syncClaims } from "./claims.ts";

export interface PromoteOptions {
  /** Only these subjects (normalized titles), e.g. after a curator decision. */
  subjects?: string[];
  /** Subjects in key order after this one (resumable batches). */
  after?: string;
  limit?: number;
  /** Below this page confidence a value is "da verificare" (default 0.6). */
  minConfidence?: number;
  /** No writes: only removes the hive pages whose subject has no active claims any more. */
  cleanup?: boolean;
  /**
   * Subjects whose removal a person confirmed (curator item "mass_change"). Without it, a cleanup
   * that would remove more than a fifth of the hive pages removes nothing and asks first.
   */
  confirmedRemovals?: string[];
}

export interface PromoteResult {
  subjects: number;
  written: number;
  unchanged: number;
  removed: number;
  /** Removals held back: too many at once, a curator item asks a person. */
  held: number;
  conflicts: number;
  decided: number;
  /** Key of the last subject handled when `limit` stopped the batch, else null. */
  next: string | null;
}

interface ClaimRow {
  id: string;
  vaultId: string;
  vaultName: string;
  pageId: string;
  pageTitle: string;
  pageType: string;
  pageUpdated: Date;
  blockId: string | null;
  predicate: string;
  value: string;
  valueNorm: string;
  observedAt: string | null;
  confidence: number | null;
  classification: number;
  visibility: number;
}

interface ValueGroup {
  value: string;
  valueNorm: string;
  claims: ClaimRow[];
}

export interface ConflictValue {
  value: string;
  valueNorm: string;
  refs: { pageId: string; blockId: string | null; vault: string; vaultName: string; observedAt: string | null }[];
}

export type Resolution = { choice: string } | { custom: string } | { keepAll: true };

const ORDER = ["postazioni", "prezzo", "rinnovo", "referente tecnico", "referente commerciale", "responsabile", "cliente", "ruolo", "database", "tecnologia", "consegna prevista"];
const orderOf = (p: string) => {
  const i = ORDER.indexOf(p);
  return i < 0 ? ORDER.length : i;
};
const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
const ref = (c: { pageId: string; blockId: string | null }) => `^[${c.pageId}${c.blockId ? `#${c.blockId}` : ""}]`;

export async function feedsOf(sql: Sql, spaceId: string): Promise<{ cellId: string; types: string[] }[]> {
  return sql<{ cellId: string; types: string[] }[]>`select cell_id as "cellId", types from hive_feeds where space_id = ${spaceId} order by cell_id`;
}

export async function setFeeds(sql: Sql, spaceId: string, feeds: { cellId: string; types?: string[] }[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from hive_feeds where space_id = ${spaceId}`;
    for (const f of feeds) {
      if (f.cellId === spaceId) continue;
      await tx`insert into hive_feeds (space_id, cell_id, types) values (${spaceId}, ${f.cellId}, ${f.types?.length ? f.types : ["entity"]})`;
    }
  });
}

/** Groups the pages that share a title or an alias (union-find). Returns page id → group root. */
function groupPages(pageIds: string[], aliases: { pageId: string; alias: string }[]): Map<string, string> {
  const parent = new Map(pageIds.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const owner = new Map<string, string>();
  for (const a of aliases) {
    if (!parent.has(a.pageId)) continue;
    const o = owner.get(a.alias);
    if (!o) owner.set(a.alias, a.pageId);
    else {
      const [x, y] = [find(o), find(a.pageId)];
      if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
    }
  }
  return new Map(pageIds.map((id) => [id, find(id)]));
}

export async function promoteSpace(sql: Sql, pages: PageStore, spaceId: string, o: PromoteOptions = {}): Promise<PromoteResult> {
  const res: PromoteResult = { subjects: 0, written: 0, unchanged: 0, removed: 0, held: 0, conflicts: 0, decided: 0, next: null };
  const feeds = await feedsOf(sql, spaceId);
  const minConfidence = o.minConfidence ?? 0.6;
  if (feeds.length) await syncClaims(sql, { vaultIds: feeds.map((f) => f.cellId) });

  const claims = feeds.length
    ? await sql<ClaimRow[]>`
        select c.id, c.vault_id as "vaultId", v.name as "vaultName", c.page_id as "pageId", p.title as "pageTitle", p.type as "pageType",
               p.updated_at as "pageUpdated", c.block_id as "blockId", c.predicate, c.value, c.value_norm as "valueNorm",
               to_char(c.observed_at, 'YYYY-MM-DD') as "observedAt", c.confidence, p.classification, p.visibility
        from claims c
        join pages p on p.id = c.page_id
        join vaults v on v.id = c.vault_id
        join hive_feeds f on f.space_id = ${spaceId} and f.cell_id = c.vault_id
        where c.status = 'active' and p.visibility >= 1 and split_part(p.type, '/', 1) = any(f.types)
        order by c.page_id, c.created_at`
    : [];
  const pageIds = [...new Set(claims.map((c) => c.pageId))];
  const aliases = pageIds.length
    ? await sql<{ pageId: string; alias: string; isTitle: boolean }[]>`select page_id as "pageId", alias_norm as alias, is_title as "isTitle" from aliases where page_id = any(${pageIds})`
    : [];
  const root = groupPages(pageIds, aliases);

  // subject key: the most frequent title of the group (ties: the longest, e.g. with the legal form)
  const groups = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    const r = root.get(c.pageId)!;
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  const subjects = new Map<string, { title: string; claims: ClaimRow[]; aliases: Set<string> }>();
  for (const cs of groups.values()) {
    const counts = new Map<string, number>();
    for (const t of new Set(cs.map((c) => `${c.pageId}\u0000${c.pageTitle}`))) {
      const title = t.split("\u0000")[1]!;
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    const title = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]![0];
    const key = normalizeTitle(title);
    const prev = subjects.get(key);
    const names = new Set([...cs.map((c) => c.pageTitle), ...(prev?.aliases ?? [])]);
    subjects.set(key, { title: prev?.title ?? title, claims: [...(prev?.claims ?? []), ...cs], aliases: names });
  }

  const existing = await sql<{ id: string; path: string; subject: string }[]>`
    select id, path, frontmatter->>'hive_subject' as subject from pages where vault_id = ${spaceId} and frontmatter ? 'hive_subject'`;
  const bySubject = new Map(existing.map((e) => [e.subject, e]));
  // pages an administrator rectified: kept as written until a curator closes the item (the
  // sources are corrected), otherwise the old text would come back tonight
  const rectified = new Set(
    (await sql<{ pageId: string }[]>`
      select page_id as "pageId" from curator_items where space_id = ${spaceId} and kind = 'rectification' and status = 'open' and page_id is not null`).map((r) => r.pageId),
  );

  let keys = [...subjects.keys()].sort();
  if (o.subjects) keys = keys.filter((k) => o.subjects!.includes(k));
  if (o.after) keys = keys.filter((k) => k > o.after!);
  const batch = o.cleanup ? [] : o.limit ? keys.slice(0, o.limit) : keys;
  if (!o.cleanup && o.limit && keys.length > o.limit) res.next = batch.at(-1)!;

  for (const key of batch) {
    const s = subjects.get(key)!;
    res.subjects++;
    if (rectified.has(bySubject.get(key)?.id ?? "")) {
      res.unchanged++;
      continue;
    }
    const out = await buildPage(sql, spaceId, key, s, minConfidence);
    res.conflicts += out.conflicts;
    res.decided += out.decided;
    const prev = bySubject.get(key);
    const w = await pages.upsert({ vaultId: spaceId, markdown: out.markdown, path: prev?.path ?? `hive/${slugify(s.title)}.md`, ...(prev ? { id: prev.id } : {}), author: "dream:promote" });
    if (w.changed) res.written++;
    else res.unchanged++;
    metrics.inc("hive_promotions", { space: spaceId, outcome: w.changed ? "written" : "unchanged" });
    await sql`update curator_items set page_id = ${w.page.id} where space_id = ${spaceId} and subject = ${key} and page_id is null`;
  }

  // subjects without active claims any more: the hive page goes, open items are superseded
  if (o.cleanup || (!o.after && !o.limit)) {
    let gone = existing.filter((e) => !subjects.has(e.subject) && !(o.subjects && !o.subjects.includes(e.subject)));
    if (o.confirmedRemovals) {
      gone = gone.filter((e) => o.confirmedRemovals!.includes(e.subject));
    } else if (isMassChange(existing.length, gone.length)) {
      // e.g. a cell unlinked by mistake, or a broken claim extraction: ask before removing
      const list = gone.map((e) => e.subject).sort();
      const fingerprint = claimHash(`${spaceId}|remove|${list.join("|")}`);
      await upsertItem(sql, spaceId, "mass_change", fingerprint, `Rimozione di ${list.length} pagine dell'alveare su ${existing.length}`, null, {
        action: "remove",
        subjects: list,
        total: existing.length,
      });
      // a request of an earlier night with another list is out of date
      await sql`update curator_items set status = 'superseded' where space_id = ${spaceId} and kind = 'mass_change' and status = 'open' and fingerprint <> ${fingerprint}`;
      metrics.inc("hive_mass_change_held", { space: spaceId });
      res.held = gone.length;
      gone = [];
    } else if (!o.subjects) {
      await sql`update curator_items set status = 'superseded' where space_id = ${spaceId} and kind = 'mass_change' and status = 'open'`;
    }
    for (const e of gone) {
      await pages.delete(e.id);
      await sql`update curator_items set status = 'superseded' where space_id = ${spaceId} and subject = ${e.subject} and status = 'open'`;
      res.removed++;
    }
  }
  return res;
}

async function buildPage(
  sql: Sql,
  spaceId: string,
  key: string,
  s: { title: string; claims: ClaimRow[]; aliases: Set<string> },
  minConfidence: number,
): Promise<{ markdown: string; conflicts: number; decided: number }> {
  const byPredicate = new Map<string, Map<string, ValueGroup>>();
  for (const c of s.claims) {
    const m = byPredicate.get(c.predicate) ?? new Map<string, ValueGroup>();
    const g = m.get(c.valueNorm) ?? { value: c.value, valueNorm: c.valueNorm, claims: [] };
    g.claims.push(c);
    m.set(c.valueNorm, g);
    byPredicate.set(c.predicate, m);
  }
  const preds = [...byPredicate.keys()].filter((p) => p !== NOTE).sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
  const pagesIn = [...new Map(s.claims.map((c) => [c.pageId, c])).values()];
  const cells = [...new Map(s.claims.map((c) => [c.vaultId, c.vaultName])).entries()];
  const refsOf = (g: ValueGroup) => [...new Map(g.claims.map((c) => [`${c.pageId}#${c.blockId}`, c])).values()];
  const sources = (g: ValueGroup) => new Set(g.claims.map((c) => c.pageId)).size;
  const lowConf = (g: ValueGroup) => g.claims.every((c) => c.confidence !== null && c.confidence < minConfidence);

  const current: string[] = [];
  const conflictBlocks: string[] = [];
  let conflicts = 0;
  let decided = 0;
  const openFingerprints: string[] = [];

  for (const p of preds) {
    const values = [...byPredicate.get(p)!.values()].sort((a, b) => sources(b) - sources(a) || a.valueNorm.localeCompare(b.valueNorm));
    if (values.length === 1) {
      const g = values[0]!;
      const n = sources(g);
      current.push(`- ${label(p)}: ${g.value} ${refsOf(g).map(ref).join(" ")}${n > 1 ? ` · ${n} fonti concordi` : ""}${lowConf(g) ? " · da verificare" : ""}`);
      if (lowConf(g)) {
        await upsertItem(sql, spaceId, "low_confidence", claimHash(`${spaceId}|${key}|${p}|${g.valueNorm}|low`), key, p, { title: s.title, value: g.value, confidence: g.claims[0]!.confidence });
      }
      continue;
    }
    // different values for the same predicate
    const fingerprint = claimHash(`${spaceId}|${key}|${p}|${values.map((v) => v.valueNorm).sort().join("|")}`);
    const conflictValues: ConflictValue[] = values.map((g) => ({
      value: g.value,
      valueNorm: g.valueNorm,
      refs: refsOf(g).map((c) => ({ pageId: c.pageId, blockId: c.blockId, vault: c.vaultId, vaultName: c.vaultName, observedAt: c.observedAt })),
    }));
    const item = await upsertItem(sql, spaceId, "conflict", fingerprint, key, p, { title: s.title, predicate: p, values: conflictValues });
    // the items of this predicate with other values (the values changed) are superseded
    await sql`
      update curator_items set status = 'superseded'
      where space_id = ${spaceId} and subject = ${key} and predicate = ${p} and kind = 'conflict' and fingerprint <> ${fingerprint} and status = 'open'`;
    const r = item.status === "resolved" ? (item.resolution as Resolution | null) : null;
    if (r && "choice" in r && values.some((v) => v.valueNorm === r.choice)) {
      const g = values.find((v) => v.valueNorm === r.choice)!;
      current.push(`- ${label(p)}: ${g.value} ${refsOf(g).map(ref).join(" ")} · deciso da un curatore`);
      decided++;
    } else if (r && "custom" in r) {
      current.push(`- ${label(p)}: ${r.custom} · deciso da un curatore (${values.length} valori nelle celle)`);
      decided++;
    } else if (r && "keepAll" in r) {
      current.push(`- ${label(p)}: ${values.map((g) => `${g.value} ${refsOf(g).map(ref).join(" ")}`).join(" · ")}`);
      decided++;
    } else {
      conflicts++;
      openFingerprints.push(fingerprint);
      conflictBlocks.push(
        [
          `> [!conflict] ${label(p)}`,
          `> Le celle riportano valori diversi. Un curatore sceglie il valore corretto.`,
          ...values.map((g) => {
            const where = [...new Set(g.claims.map((c) => c.vaultName))].join(", ");
            const when = g.claims.map((c) => c.observedAt).filter(Boolean).sort().at(-1);
            return `> - ${g.value} ${refsOf(g).map(ref).join(" ")} — ${where}${when ? `, ${when}` : ""}`;
          }),
        ].join("\n"),
      );
    }
  }

  const notes = byPredicate.get(NOTE);
  const other = notes ? [...notes.values()].map((g) => `- ${g.value} ${refsOf(g).map(ref).join(" ")}`) : [];
  const types = new Map<string, number>();
  for (const c of pagesIn) types.set(c.pageType, (types.get(c.pageType) ?? 0) + 1);
  const type = [...types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const classification = Math.max(...s.claims.map((c) => c.classification));
  const visibility = Math.min(...pagesIn.map((c) => c.visibility));
  const statements = preds.length + other.length;

  const fm = {
    title: s.title,
    type,
    aliases: [...s.aliases].filter((a) => normalizeTitle(a) !== key).sort(),
    tags: ["alveare"],
    tldr: `${s.title}: ${statements} ${statements === 1 ? "informazione" : "informazioni"} da ${cells.length} ${cells.length === 1 ? "cella" : "celle"}${conflicts ? `, ${conflicts} in conflitto` : ""}.`,
    classification: CLASSIFICATIONS[classification],
    visibility: VISIBILITIES[visibility],
    hive_subject: key,
    promoted_from: cells.map(([id]) => id).sort(),
    sources_count: pagesIn.length,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");
  const body = [
    `# ${s.title}`,
    ``,
    `> [!info] Pagina dell'alveare`,
    `> Costruita dalle celle ${cells.map(([, n]) => n).join(", ")}. Ogni informazione cita la pagina di origine.`,
    ``,
    `## Stato attuale`,
    ...(current.length ? current : ["- Nessuna informazione concorde."]),
    ``,
    ...(conflictBlocks.length ? [conflictBlocks.join("\n\n"), ""] : []),
    ...(other.length ? [`## Altre informazioni`, ...other, ``] : []),
    `## Provenienza`,
    ...pagesIn
      .sort((a, b) => a.vaultName.localeCompare(b.vaultName) || a.pageTitle.localeCompare(b.pageTitle))
      .map((c) => `- ${c.vaultName} · «${c.pageTitle}» · aggiornata ${c.pageUpdated.toISOString().slice(0, 10)} ^[${c.pageId}]`),
  ].join("\n");
  return { markdown: `---\n${yaml}\n---\n${body}\n`, conflicts, decided };
}

/** Creates the item if new; returns its current status and resolution. */
async function upsertItem(
  sql: Sql,
  spaceId: string,
  kind: "conflict" | "low_confidence" | "duplicate" | "lint" | "proposal" | "mass_change" | "rectification",
  fingerprint: string,
  subject: string,
  predicate: string | null,
  data: Record<string, unknown>,
): Promise<{ id: string; status: string; resolution: unknown }> {
  const [row] = await sql<{ id: string; status: string; resolution: unknown }[]>`
    insert into curator_items (id, space_id, kind, fingerprint, subject, predicate, data)
    values (${newId("cur")}, ${spaceId}, ${kind}, ${fingerprint}, ${subject}, ${predicate}, ${sql.json(data as never)})
    on conflict (space_id, fingerprint) do update
      set data = excluded.data,
          -- an item superseded earlier comes back when the same values return
          status = case when curator_items.status = 'superseded' then 'open' else curator_items.status end
    returning id, status, resolution`;
  return row!;
}

export { upsertItem as upsertCuratorItem };
