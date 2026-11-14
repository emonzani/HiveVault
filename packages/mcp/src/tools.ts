/**
 * The 9 tools of the MCP server (plan §7.1), independent of the protocol: each one takes the
 * caller's context and returns compact Markdown for the cloud agent. The MCP server, the tests and the
 * retrieval eval call the same functions.
 *
 * Rules:
 * - The cloud agent never reads above "interno" (plan §3.6): the reader clearance is capped at 1,
 *   whatever the API account has. Row Level Security applies it again in the database.
 * - Original files never leave the server (invariant 1): `brain_source` returns extracted text.
 * - Every element says its cost in tokens; every tool takes a budget.
 * - Reads are audited (buffered); writes are audited at once and never touch the hive directly.
 */
import type { AuditLog } from "@cb/auth";
import {
  backlinks,
  extractCitations,
  neighbors,
  normalizeTitle,
  PageStore,
  readPage,
  sections,
  slugify,
  withReader,
  type Principal,
  type SearchEngine,
  type SearchHit,
} from "@cb/brain";
import type { Sql } from "@cb/db";
import { upsertCuratorItem } from "@cb/hive";
import type { ModelDispatcher } from "@cb/models";
import { estimateTokens } from "@cb/shared";
import { createHash } from "node:crypto";

/** Hits re-scored by the reranker in brain_search (MCP_RERANK_TOP). */
const RERANK_TOP = Math.max(2, Number(process.env.MCP_RERANK_TOP ?? 20) || 20);

/** Highest classification readable through MCP: 0 pubblico, 1 interno. */
export const MCP_MAX_CLASSIFICATION = 1;
const LEVEL = ["I0", "I1", "I2", "I3"];
const CLASS = ["pubblico", "interno", "riservato", "segreto", "personale"];

export interface ToolContext {
  sql: Sql;
  search: SearchEngine;
  pages: PageStore;
  dispatcher?: ModelDispatcher;
  audit?: AuditLog;
  /** The API account. */
  account: { id: string; name: string; scopes: string[]; clearance: number };
  /** Readable vaults (from Access.toReader) and their permission. */
  vaults: Map<string, string>;
  meta?: { ip?: string | null; userAgent?: string | null };
  /** Ingestion of the server: a note captured with `compile` becomes a source (I1–I3). */
  ingest?: SourceSink;
}

/** What brain_capture needs of the ingestion service (`IngestService.upload`). */
export interface SourceSink {
  upload(vaultId: string, data: Buffer, name: string, by: string | null, o?: { classification?: number; compile?: boolean }): Promise<{ source: { id: string; name: string }; created: boolean; taskId: string | null }>;
}

export class ToolError extends Error {}

export function readerOf(ctx: ToolContext, only?: string[]): Principal {
  const vaults = [...ctx.vaults.keys()].filter((v) => !only || only.includes(v));
  return { id: ctx.account.id, vaults, clearance: Math.min(ctx.account.clearance, MCP_MAX_CLASSIFICATION) };
}

// "projects" writes only project vaults: its other vaults are capped at read (Access.apiContext)
const canWrite = (ctx: ToolContext) => ctx.account.scopes.some((s) => s === "write" || s === "ingest" || s === "projects");

/** Vault slugs or ids → ids among the readable vaults. */
async function resolveVaults(ctx: ToolContext, refs?: string[]): Promise<string[] | undefined> {
  if (!refs?.length) return undefined;
  const rows = await ctx.sql<{ id: string; slug: string }[]>`select id, slug from vaults where id = any(${[...ctx.vaults.keys()]})`;
  const ids = refs.map((r) => rows.find((v) => v.id === r || v.slug === r)?.id);
  const missing = refs.filter((_, i) => !ids[i]);
  if (missing.length) throw new ToolError(`Vault non trovati o non accessibili: ${missing.join(", ")}. Usa brain_overview per l'elenco.`);
  return ids as string[];
}

function audit(ctx: ToolContext, action: string, resource: string | null, data: Record<string, unknown>) {
  ctx.audit?.write({ principalId: ctx.account.id, action, resource, ...ctx.meta, data: { ...data, via: "mcp" } });
}

const tok = (n: number) => `${n.toLocaleString("it-IT")} token`;

// ---------------------------------------------------------------------------
// brain_overview
// ---------------------------------------------------------------------------

export async function brainOverview(ctx: ToolContext): Promise<string> {
  const p = readerOf(ctx);
  if (!p.vaults.length) return "Nessun vault accessibile a questo account. Chiedi all'amministratore di concedere l'accesso.";
  const rows = await withReader(ctx.sql, p, (tx) => tx<{ id: string; slug: string; name: string; kind: string; folders: Record<string, number> | null; levels: Record<string, number> | null; updated: string | null }[]>`
    select v.id, v.slug, v.name, v.kind,
           (select json_object_agg(f, n) from (select split_part(type, '/', 1) as f, count(*)::int as n from pages where vault_id = v.id group by 1) x) as folders,
           (select json_object_agg(level, n) from (select level, count(*)::int as n from sources where vault_id = v.id and parent_id is null group by 1) y) as levels,
           (select to_char(max(updated_at), 'YYYY-MM-DD') from pages where vault_id = v.id) as updated
    from vaults v where v.id = any(${p.vaults}) order by v.kind, v.name`);
  const recent = await withReader(ctx.sql, p, (tx) => tx<{ id: string; title: string; vault: string; day: string }[]>`
    select p.id, p.title, v.slug as vault, to_char(p.updated_at, 'YYYY-MM-DD') as day
    from pages p join vaults v on v.id = p.vault_id
    where p.vault_id = any(${p.vaults}) and p.path not like '\\_inbox/%' order by p.updated_at desc limit 8`);
  const lines = [
    `# HiveVault`,
    ``,
    `Memoria aziendale compilata in pagine collegate. Vedi solo le pagine «pubblico» e «interno» dei vault concessi a questo account.`,
    `Flusso consigliato: brain_search → brain_read (con max_tokens) → brain_neighbors / brain_timeline. Cita ogni fatto con l'id tra ^[ ].`,
    ``,
    `## Vault (${rows.length})`,
  ];
  for (const v of rows) {
    const pages = Object.values(v.folders ?? {}).reduce((a, b) => a + b, 0);
    const lv = v.levels ?? {};
    const sources = Object.values(lv).reduce((a, b) => a + b, 0);
    const cov = sources ? ` · documenti ${sources} (I1 ${lv["1"] ?? 0}, I2 ${lv["2"] ?? 0}, I3 ${lv["3"] ?? 0})` : "";
    const folders = Object.entries(v.folders ?? {}).sort().map(([f, n]) => `${f} ${n}`).join(", ");
    lines.push(`- **${v.name}** \`${v.slug}\` (${v.kind === "space" ? "alveare" : "cella"}): ${pages} pagine${folders ? ` (${folders})` : ""}${cov}${v.updated ? ` · aggiornato ${v.updated}` : ""}`);
  }
  if (recent.length) {
    lines.push(``, `## Aggiornate di recente`, ...recent.map((r) => `- [${r.id}] ${r.title} · ${r.vault} · ${r.day}`));
  }
  lines.push(``, `Livelli: I1 cercabile per parole, I2 anche per significato, I3 compilato in pagine. Indici: risorse brain://<vault>/index e brain://<vault>/llms.txt; cosa è cambiato: brain://<vault>/changes?since=<data>.`);
  audit(ctx, "mcp.overview", null, { vaults: rows.length });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// brain_search
// ---------------------------------------------------------------------------

export interface SearchArgs {
  query: string;
  vaults?: string[];
  types?: string[];
  limit?: number;
  max_tokens?: number;
}

export async function brainSearchRaw(ctx: ToolContext, a: SearchArgs) {
  const only = await resolveVaults(ctx, a.vaults);
  const p = readerOf(ctx, only);
  if (!p.vaults.length) throw new ToolError("Nessun vault accessibile.");
  const r = await ctx.search.search(p, a.query, {
    limit: Math.min(a.limit ?? 8, 20),
    maxTokens: Math.min(a.max_tokens ?? 2000, 8000),
    rerank: true,
    // eval of phase 6 on a CPU reranker: 20 candidates recall@5 0.992 in 5.3 s, 10 candidates
    // 0.962 in 2.7 s. The cloud agent needs the source more than two seconds: 20 by default.
    rerankTop: RERANK_TOP,
    ...(a.types?.length ? { types: a.types } : {}),
  });
  audit(ctx, "search", null, { query: a.query.slice(0, 200), hits: r.hits.map((h) => ({ id: h.id, classification: h.classification })) });
  return r;
}

/** Documents uploaded in the last days are "recent" in the search results (M15). */
const RECENT_DAYS = 7;

function hitLine(h: SearchHit, i: number, recent: Set<string>): string {
  const kind = h.kind === "page" ? h.type : "documento";
  // M15: a document not compiled yet may say what no page says yet
  const pending = h.kind === "source" && h.level !== "I3" ? (recent.has(h.id) ? " · documento recente, non ancora compilato" : " · non ancora compilato") : "";
  const head = `${i + 1}. [${h.id}] **${h.title}** — ${kind} · ${LEVEL[h.level === "I3" ? 3 : h.level === "I2" ? 2 : 1]} · ${tok(h.tokens)}${pending}`;
  const tldr = h.tldr ? `\n   ${h.tldr.replace(/\s+/g, " ").slice(0, 240)}` : "";
  const snippets = h.chunks
    .slice(0, 2)
    .map((c) => `\n   «${c.snippet.replace(/\s+/g, " ").trim()}» ^[${h.kind === "source" ? c.id.replace(/:(\d+)$/, "#c$1") : h.cite}]`)
    .join("");
  return head + tldr + snippets;
}

export async function brainSearch(ctx: ToolContext, a: SearchArgs): Promise<string> {
  const r = await brainSearchRaw(ctx, a);
  if (!r.hits.length) return `Nessun risultato per «${a.query}». Prova con altre parole, un nome proprio o un sinonimo; la memoria potrebbe non contenere questa informazione.`;
  const notes = [r.degraded.includes("vector") ? "ricerca per significato non disponibile ora: solo parole chiave" : "", r.degraded.includes("rerank") ? "riordino non disponibile" : ""].filter(Boolean);
  const pending = r.hits.filter((h) => h.kind === "source" && h.level !== "I3").map((h) => h.id);
  const recent = new Set(
    pending.length
      ? (
          await withReader(ctx.sql, readerOf(ctx), (tx) => tx<{ id: string }[]>`
            select id from sources where id = any(${pending}) and created_at > now() - make_interval(days => ${RECENT_DAYS})`)
        ).map((x) => x.id)
      : [],
  );
  return [
    `${r.hits.length} risultati per «${a.query}» (${tok(r.totalTokens)} in tutto${notes.length ? `; ${notes.join("; ")}` : ""}).`,
    `Leggi una pagina con brain_read(id); un documento non compilato con brain_read(id) o brain_source(citazione).`,
    ...(pending.length
      ? [`${pending.length} ${pending.length === 1 ? "risultato è un documento" : "risultati sono documenti"} non ancora compilati: le pagine potrebbero non dire ancora quello che dicono. Leggili con brain_read prima di rispondere che un'informazione manca.`]
      : []),
    ``,
    ...r.hits.map((h, i) => hitLine(h, i, recent)),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// brain_read
// ---------------------------------------------------------------------------

export interface ReadArgs {
  id: string;
  sections?: string[];
  max_tokens?: number;
  query?: string;
}

export async function brainRead(ctx: ToolContext, a: ReadArgs): Promise<string> {
  const p = readerOf(ctx);
  const budget = Math.min(Math.max(a.max_tokens ?? 2000, 100), 12000);
  if (/^src_/.test(a.id)) return readSource(ctx, p, a.id, budget, a.query);
  const r = await readPage(ctx.sql, p, a.id, { maxTokens: budget, ...(a.sections?.length ? { sections: a.sections } : {}), ...(a.query ? { query: a.query } : {}) });
  if (!r) throw new ToolError(`Pagina «${a.id}» non trovata o non accessibile. Cerca con brain_search.`);
  audit(ctx, "page.read", r.id, { classification: r.classification, tokens: r.contentTokens });
  const omitted = r.omitted.length ? `\n\n---\nSezioni non incluse: ${r.omitted.map((s) => `${s.id} (${tok(s.tokens)})`).join(", ")}. Leggile con sections=[…].` : "";
  const newer = r.type.split("/")[0] === "source" ? [] : await newerSources(ctx, p, r.id);
  return [
    `[${r.id}] ${r.type} · ${CLASS[r.classification]} · versione ${r.version} · aggiornata ${new Date(r.updatedAt).toISOString().slice(0, 10)} · pagina intera ${tok(r.tokens)} · qui ${tok(r.contentTokens)} · ${r.backlinks} backlink`,
    `Cita come ^[${r.id}#sezione].`,
    ...(newer.length
      ? [
          `Attenzione: ${newer.length === 1 ? "un documento più recente della pagina parla" : `${newer.length} documenti più recenti della pagina parlano`} dello stesso soggetto e la pagina non ${newer.length === 1 ? "lo cita" : "li cita"}: ${newer.map((s) => `[${s.id}] «${s.title}» (${s.date}, ${LEVEL[s.level] ?? "I0"})`).join("; ")}. Leggili con brain_read prima di dare lo stato attuale per certo.`,
        ]
      : []),
    ``,
    r.content.trim() + omitted,
  ].join("\n");
}

/**
 * M16: documents newer than what a page knows that write its title (or one of its first aliases)
 * and that the page does not cite: what the page may not know yet. At most 3, newest first, in
 * the vaults the reader may read (RLS). "Newer" is after the newest document the page cites (or
 * after the page was created), not after `updated_at`: the link task and the dream cycle write
 * pages every few minutes, and that would hide every warning.
 */
async function newerSources(ctx: ToolContext, p: Principal, pageId: string): Promise<{ id: string; title: string; level: number; date: string }[]> {
  return withReader(ctx.sql, p, async (tx) => {
    const [page] = await tx<{ title: string; aliases: string[] | null; body: string; createdAt: string }[]>`
      select title, case when jsonb_typeof(frontmatter->'aliases') = 'array' then array(select jsonb_array_elements_text(frontmatter->'aliases')) end as aliases,
             body, created_at::text as "createdAt"
      from pages where id = ${pageId}`;
    if (!page) return [];
    const cited = [...new Set(extractCitations(page.body).map((c) => c.source).filter((s) => s.startsWith("src_")))];
    const [known] = await tx<{ t: string }[]>`
      select coalesce((select max(created_at) from sources where id = any(${cited})), ${page.createdAt}::timestamptz)::text as t`;
    const names = [page.title, ...(page.aliases ?? [])].filter((n) => n.trim().length >= 4).slice(0, 4);
    if (!names.length) return [];
    const found: { id: string; title: string; level: number; date: string }[] = [];
    for (const name of names) {
      if (found.length >= 3) break;
      const rows = await tx<{ id: string; title: string; level: number; date: string }[]>`
        select s.id, coalesce(s.title, s.name) as title, s.level, to_char(s.created_at, 'YYYY-MM-DD') as date
        from sources s
        where s.vault_id = any(${p.vaults}) and s.created_at > ${known!.t}::timestamptz and s.id <> all(${found.map((f) => f.id)})
          and exists (select 1 from chunks c where c.vault_id = s.vault_id and c.source_id = s.id
                      and c.tsv @@ (phraseto_tsquery('italian', ${name}) || phraseto_tsquery('english', ${name}) || phraseto_tsquery('simple', ${name})))
        order by s.created_at desc limit 3`;
      for (const s of rows) if (!page.body.includes(`^[${s.id}`) && found.length < 3) found.push(s);
    }
    return found;
  });
}

// ---------------------------------------------------------------------------
// brain://<vault>/changes (M17)
// ---------------------------------------------------------------------------

/**
 * What changed in a vault since a time: pages written (new or updated) and documents added,
 * newest first, under the reader's clearance. A recurring session of the cloud agent reads only
 * this, then the pages it needs. `since`: ISO date or time; default the last 24 hours.
 */
export async function brainChanges(ctx: ToolContext, a: { vault: string; since?: string; limit?: number }): Promise<string> {
  const [id] = (await resolveVaults(ctx, [a.vault])) ?? [];
  const p = readerOf(ctx, [id!]);
  const since = a.since ? new Date(a.since) : null;
  if (a.since && (!since || Number.isNaN(since.getTime()))) throw new ToolError(`since «${a.since}» non è una data: usa per esempio 2026-11-11 o 2026-11-11T08:00:00Z.`);
  const limit = Math.min(Math.max(a.limit ?? 50, 1), 200);
  const r = await withReader(ctx.sql, p, async (tx) => {
    const [t] = await tx<{ now: string; from: string }[]>`
      select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as now,
             to_char(coalesce(${since?.toISOString() ?? null}::timestamptz, now() - interval '24 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as from`;
    const pages = await tx<{ id: string; title: string; type: string; version: number; tldr: string; created: boolean; at: string }[]>`
      select id, title, type, version, tldr, created_at > ${t!.from}::timestamptz as created, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at
      from pages where vault_id = ${id!} and updated_at > ${t!.from}::timestamptz
      order by updated_at desc limit ${limit}`;
    const sources = await tx<{ id: string; title: string; level: number; at: string }[]>`
      select id, coalesce(title, name) as title, level, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at
      from sources where vault_id = ${id!} and created_at > ${t!.from}::timestamptz and parent_id is null
      order by created_at desc limit ${limit}`;
    const [slug] = await tx<{ slug: string; name: string }[]>`select slug, name from vaults where id = ${id!}`;
    return { ...t!, pages, sources, vault: slug! };
  });
  audit(ctx, "mcp.resource", `${r.vault.slug}/changes`, { since: r.from, pages: r.pages.length, sources: r.sources.length });
  const lines = [
    `# Modifiche di ${r.vault.name} dal ${r.from} al ${r.now}`,
    ``,
    `${r.pages.length} pagine scritte, ${r.sources.length} documenti aggiunti${r.pages.length >= limit || r.sources.length >= limit ? ` (primi ${limit})` : ""}. Leggi le pagine con brain_read(id).`,
    ``,
    `## Pagine`,
    ...(r.pages.length ? r.pages.map((x) => `- [${x.id}] **${x.title}** — ${x.type} · ${x.created ? "nuova" : `versione ${x.version}`} · ${x.at}${x.tldr ? ` — ${x.tldr.replace(/\s+/g, " ").slice(0, 160)}` : ""}`) : ["Nessuna."]),
    ``,
    `## Documenti`,
    ...(r.sources.length ? r.sources.map((x) => `- [${x.id}] «${x.title}» · ${LEVEL[x.level] ?? "I0"} · ${x.at}`) : ["Nessuno."]),
    ``,
    `Prossima lettura: brain://${r.vault.slug}/changes?since=${r.now}`,
  ];
  return lines.join("\n");
}

/** A document not compiled into a page: its best chunks within the budget, each with its citation. */
async function readSource(ctx: ToolContext, p: Principal, id: string, budget: number, query?: string): Promise<string> {
  const rows = await withReader(ctx.sql, p, async (tx) => {
    const [s] = await tx<{ id: string; name: string; title: string | null; classification: number; level: number; compiledPage: string | null }[]>`
      select id, name, title, classification, level, compiled_page as "compiledPage" from sources where vault_id = any(${p.vaults}) and id = ${id}`;
    if (!s) return null;
    const chunks = query
      ? await tx<{ id: string; ord: number; heading: string | null; text: string; tokens: number }[]>`
          select id, ord, heading, text, tokens from chunks where vault_id = any(${p.vaults}) and source_id = ${id}
          order by ts_rank_cd(tsv, websearch_to_tsquery('italian', ${query}) || websearch_to_tsquery('english', ${query})) desc, ord limit 200`
      : await tx<{ id: string; ord: number; heading: string | null; text: string; tokens: number }[]>`
          select id, ord, heading, text, tokens from chunks where vault_id = any(${p.vaults}) and source_id = ${id} order by ord limit 200`;
    return { s, chunks };
  });
  if (!rows) throw new ToolError(`Documento «${id}» non trovato o non accessibile.`);
  const { s, chunks } = rows;
  let used = 0;
  const out: string[] = [];
  for (const c of chunks) {
    if (used + c.tokens > budget && out.length) break;
    used += c.tokens;
    out.push(`### Parte ${c.ord}${c.heading ? ` · ${c.heading}` : ""} ^[${id}#c${c.ord}]\n${c.text.trim()}`);
  }
  audit(ctx, "source.read", id, { classification: s.classification, tokens: used, chunks: out.length });
  return [
    `[${s.id}] documento «${s.title ?? s.name}» · ${CLASS[s.classification]} · ${LEVEL[s.level] ?? "I0"} · ${out.length} di ${chunks.length} parti · ${tok(used)}`,
    s.compiledPage ? `Pagina compilata: [${s.compiledPage}] (preferiscila).` : `Non compilato: testo estratto dal documento.`,
    ``,
    ...out,
    ...(chunks.length > out.length ? [`\n---\nAltre ${chunks.length - out.length} parti oltre il budget: aumenta max_tokens o passa query per le parti pertinenti.`] : []),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// brain_neighbors
// ---------------------------------------------------------------------------

async function resolvePageId(ctx: ToolContext, p: Principal, idOrTitle: string): Promise<{ id: string; title: string } | undefined> {
  return withReader(ctx.sql, p, async (tx) => {
    const page = (await PageStore.get(tx, idOrTitle)) ?? (await PageStore.resolve(tx, p.vaults, idOrTitle))[0];
    return page ? { id: page.id, title: page.title } : undefined;
  });
}

export async function brainNeighbors(ctx: ToolContext, a: { id: string; depth?: number }): Promise<string> {
  const p = readerOf(ctx);
  const page = await resolvePageId(ctx, p, a.id);
  if (!page) throw new ToolError(`Pagina «${a.id}» non trovata o non accessibile.`);
  const depth = Math.min(Math.max(a.depth ?? 1, 1), 2);
  const [g, bl] = await Promise.all([neighbors(ctx.sql, p, page.id, depth, 40), backlinks(ctx.sql, p, page.id, 40)]);
  const out = g.edges.filter((e) => e.from === page.id).map((e) => e.to);
  const inc = new Set(g.edges.filter((e) => e.to === page.id).map((e) => e.from));
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  const line = (id: string, rel: string) => {
    const n = node.get(id);
    return n ? `- [${n.id}] ${n.title} — ${n.type} · ${rel}${n.depth > 1 ? ` (a ${n.depth} passi)` : ""}` : null;
  };
  audit(ctx, "mcp.neighbors", page.id, { nodes: g.nodes.length });
  const far = g.nodes.filter((n) => n.depth > 1).map((n) => line(n.id, "collegata indirettamente"));
  return [
    `Collegamenti di [${page.id}] «${page.title}» (profondità ${depth}).`,
    ``,
    `## Collega a`,
    ...(out.length ? [...new Set(out)].map((id) => line(id, "link in uscita")).filter(Boolean) : ["- nessuna"]),
    ``,
    `## Collegata da`,
    ...(inc.size ? [...inc].map((id) => line(id, "backlink")).filter(Boolean) : ["- nessuna"]),
    ...(bl.mentions.length ? [``, `## Menzioni senza link`, ...bl.mentions.slice(0, 10).map((m) => `- [${m.id}] ${m.title}`)] : []),
    ...(far.length ? [``, `## Più lontane`, ...far.filter(Boolean)] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// brain_timeline
// ---------------------------------------------------------------------------

const TL = /^(timeline|cronologia|storia|history|eventi)$/i;
function dateOf(line: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(line);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const it = /(\d{2})\/(\d{2})\/(\d{4})/.exec(line);
  return it ? `${it[3]}-${it[2]}-${it[1]}` : null;
}

export async function brainTimeline(ctx: ToolContext, a: { entity?: string; from?: string; to?: string; limit?: number }): Promise<string> {
  const p = readerOf(ctx);
  const limit = Math.min(a.limit ?? 40, 200);
  const inRange = (d: string) => (!a.from || d >= a.from) && (!a.to || d <= a.to);
  if (a.entity) {
    const page = await resolvePageId(ctx, p, a.entity);
    if (!page) throw new ToolError(`Entità «${a.entity}» non trovata o non accessibile.`);
    const events: { day: string; text: string; from: string }[] = [];
    const rows = await withReader(ctx.sql, p, (tx) => tx<{ id: string; title: string; body: string }[]>`
      select p.id, p.title, p.body from pages p
      where p.id = ${page.id}
         or p.id in (select l.src_page from links l where l.vault_id = any(${p.vaults}) and l.dst_page = ${page.id})
      limit 60`);
    const name = normalizeTitle(page.title);
    for (const r of rows) {
      for (const s of sections(r.body)) {
        if (!TL.test(s.title)) continue;
        for (const raw of r.body.slice(s.start, s.end).split("\n")) {
          const line = raw.replace(/^\s*[-*]\s+/, "").trim();
          const day = dateOf(line);
          if (!day || !inRange(day)) continue;
          // in other pages only the lines about this entity
          if (r.id !== page.id && !normalizeTitle(line).includes(name)) continue;
          events.push({ day, text: line, from: r.id === page.id ? "" : ` (da [${r.id}] ${r.title})` });
        }
      }
    }
    events.sort((x, y) => y.day.localeCompare(x.day));
    audit(ctx, "mcp.timeline", page.id, { events: events.length });
    if (!events.length) return `Nessun evento datato per «${page.title}»${a.from || a.to ? " nel periodo" : ""}. La pagina [${page.id}] potrebbe non avere una sezione Timeline.`;
    return [`Eventi di [${page.id}] «${page.title}», dal più recente:`, ``, ...events.slice(0, limit).map((e) => `- ${e.day} · ${e.text}${e.from}`)].join("\n");
  }
  // a period: what happened in the vaults (ingestion, compilation, merges, nightly cycles)
  const rows = await withReader(ctx.sql, p, (tx) => tx<{ day: string; kind: string; title: string; vault: string }[]>`
    select to_char(l.at, 'YYYY-MM-DD') as day, l.kind, l.title, v.slug as vault from vault_log l join vaults v on v.id = l.vault_id
    where l.vault_id = any(${p.vaults}) and (${a.from ?? null}::date is null or l.at >= ${a.from ?? null}::date)
      and (${a.to ?? null}::date is null or l.at < ${a.to ?? null}::date + 1)
    order by l.at desc limit ${limit}`);
  audit(ctx, "mcp.timeline", null, { events: rows.length });
  if (!rows.length) return "Nessun evento nel periodo.";
  return [`Eventi dei vault${a.from || a.to ? ` dal ${a.from ?? "…"} al ${a.to ?? "…"}` : ""}:`, ``, ...rows.map((r) => `- ${r.day} · ${r.vault} · ${r.kind}: ${r.title}`)].join("\n");
}

// ---------------------------------------------------------------------------
// brain_source
// ---------------------------------------------------------------------------

export async function brainSource(ctx: ToolContext, a: { ref: string; context?: number }): Promise<string> {
  const p = readerOf(ctx);
  const ref = a.ref.replace(/^\^\[|\]$/g, "").trim();
  const m = /^(src_[A-Za-z0-9]+)(?:#c(\d+)|:(\d+))?$/.exec(ref);
  if (!m) {
    // a page citation ^[page#section]: read that section
    const [id, section] = ref.split("#");
    if (/^(ent|cpt|dec|syn|pag|spg)_/.test(id ?? "")) return brainRead(ctx, { id: id!, ...(section ? { sections: [section] } : {}), max_tokens: 1500 });
    throw new ToolError(`Citazione non valida: «${a.ref}». Formato: src_…#c3 oppure pagina#sezione.`);
  }
  const src = m[1]!;
  const ord = Number(m[2] ?? m[3] ?? 0);
  const ctxN = Math.min(Math.max(a.context ?? 0, 0), 3);
  const r = await withReader(ctx.sql, p, async (tx) => {
    const [s] = await tx<{ name: string; title: string | null; classification: number; path: string | null; origin: string }[]>`
      select name, title, classification, path, origin from sources where vault_id = any(${p.vaults}) and id = ${src}`;
    if (!s) return null;
    const chunks = await tx<{ ord: number; heading: string | null; text: string; tokens: number }[]>`
      select ord, heading, text, tokens from chunks where vault_id = any(${p.vaults}) and source_id = ${src}
        and ord between ${ord - ctxN} and ${ord + ctxN} order by ord`;
    return { s, chunks };
  });
  if (!r || !r.chunks.some((c) => c.ord === ord)) throw new ToolError(`Fonte «${ref}» non trovata o non accessibile.`);
  audit(ctx, "source.read", `${src}:${ord}`, { classification: r.s.classification });
  return [
    `Fonte ^[${src}#c${ord}] · documento «${r.s.title ?? r.s.name}» (${r.s.origin}) · ${CLASS[r.s.classification]}. Testo estratto; il file originale resta sul server.`,
    ``,
    ...r.chunks.map((c) => `${c.ord === ord ? "▶ " : ""}Parte ${c.ord}${c.heading ? ` · ${c.heading}` : ""}:\n${c.text.trim()}`),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// brain_ask (local model)
// ---------------------------------------------------------------------------

export interface AskResult {
  answer: string;
  citations: string[];
  unknown: string[];
  tokens: number;
  context: string[];
}

export async function brainAskRaw(ctx: ToolContext, a: { question: string; vaults?: string[]; max_tokens?: number }): Promise<AskResult> {
  if (!ctx.dispatcher) throw new ToolError("Il modello locale non è configurato su questo server.");
  const r = await brainSearchRaw(ctx, { query: a.question, ...(a.vaults ? { vaults: a.vaults } : {}), limit: 6, max_tokens: 4000 });
  if (!r.hits.length) return { answer: "La memoria non contiene informazioni su questa domanda.", citations: [], unknown: [], tokens: 0, context: [] };
  const p = readerOf(ctx);
  const budget = Math.min(a.max_tokens ?? 3000, 6000);
  const blocks: string[] = [];
  const ids = new Set<string>();
  let used = 0;
  for (const h of r.hits) {
    if (used > budget) break;
    if (h.kind === "page") {
      const page = await readPage(ctx.sql, p, h.id, { maxTokens: Math.min(1200, budget - used), query: a.question });
      if (!page) continue;
      audit(ctx, "page.read", page.id, { classification: page.classification, tokens: page.contentTokens, ask: true });
      blocks.push(`<pagina id="${page.id}">\n${page.content}\n</pagina>`);
      ids.add(page.id);
      used += page.contentTokens;
    } else {
      for (const c of h.chunks.slice(0, 2)) {
        const cite = c.id.replace(/:(\d+)$/, "#c$1");
        const [row] = await withReader(ctx.sql, p, (tx) => tx<{ text: string; tokens: number }[]>`select text, tokens from chunks where vault_id = any(${p.vaults}) and id = ${c.id}`);
        if (!row) continue;
        blocks.push(`<fonte id="${cite}" documento="${h.title}">\n${row.text}\n</fonte>`);
        ids.add(cite);
        ids.add(h.id);
        used += row.tokens;
      }
    }
  }
  const res = await ctx.dispatcher.chat(
    {
      messages: [
        {
          role: "system",
          content:
            "Rispondi alla domanda solo con le informazioni fornite tra i tag. Ogni fatto cita la sua fonte con ^[id] usando gli id dei tag (pagina o fonte). " +
            "Se le fonti riportano valori diversi per la stessa informazione, dillo e indica il valore più recente. Se la risposta non c'è, scrivi che la memoria non lo sa. Rispondi in italiano, in modo breve.",
        },
        { role: "user", content: `${blocks.join("\n\n")}\n\nDomanda: ${a.question}` },
      ],
      maxTokens: 700,
      temperature: 0,
      thinking: false,
    },
    { priority: 0 },
  );
  const answer = res.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const cited = [...answer.matchAll(/\^\[([^\]\n]+)\]/g)].map((m) => m[1]!.trim());
  const known = (c: string) => ids.has(c) || ids.has(c.split("#")[0]!);
  return { answer, citations: cited.filter(known), unknown: cited.filter((c) => !known(c)), tokens: res.usage.promptTokens + res.usage.completionTokens, context: [...ids] };
}

export async function brainAsk(ctx: ToolContext, a: { question: string; vaults?: string[]; max_tokens?: number }): Promise<string> {
  const r = await brainAskRaw(ctx, a);
  return [
    r.answer,
    ``,
    `---`,
    `Risposta del modello locale di HiveVault su ${r.context.length} fonti.${r.unknown.length ? ` Citazioni non verificabili rimosse dal conteggio: ${r.unknown.join(", ")}.` : ""} Verifica i punti importanti con brain_read o brain_source.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// brain_capture and brain_propose_edit (writes)
// ---------------------------------------------------------------------------

async function writableVault(ctx: ToolContext, ref?: string): Promise<{ id: string; slug: string; name: string; owner: string | null }> {
  const writable = [...ctx.vaults.entries()].filter(([, perm]) => perm !== "read").map(([id]) => id);
  const rows = await ctx.sql<{ id: string; slug: string; name: string; kind: string; owner: string | null }[]>`select id, slug, name, kind, owner from vaults where id = any(${writable}) order by kind, name`;
  if (ref) {
    const v = rows.find((x) => x.id === ref || x.slug === ref);
    if (!v) throw new ToolError(`Il vault «${ref}» non è scrivibile da questo account. Scrivibili: ${rows.map((x) => x.slug).join(", ") || "nessuno"}.`);
    return v;
  }
  const cells = rows.filter((x) => x.kind === "cell");
  if (cells.length === 1) return cells[0]!;
  if (rows.length === 1) return rows[0]!;
  throw new ToolError(`Indica il vault con vault=… Scrivibili: ${rows.map((x) => x.slug).join(", ") || "nessuno"}.`);
}

export async function brainCapture(
  ctx: ToolContext,
  a: { title: string; content: string; vault?: string; tags?: string[]; classification?: "pubblico" | "interno"; compile?: boolean },
): Promise<string> {
  if (!canWrite(ctx)) throw new ToolError("Questo account API può solo leggere (serve l'ambito write).");
  const v = await writableVault(ctx, a.vault);
  const title = a.title.trim().slice(0, 200);
  if (!title || !a.content.trim()) throw new ToolError("Servono titolo e contenuto.");
  // a project vault sends the note to ingestion by default: the compiler turns it into pages
  if (a.compile ?? !!v.owner?.startsWith("project:")) return captureAsSource(ctx, v, title, a);
  const day = new Date().toISOString().slice(0, 10);
  const exists = (await PageStore.resolve(ctx.sql, [v.id], title)).length > 0;
  const finalTitle = exists ? `${title} (${day} ${new Date().toISOString().slice(11, 16)})` : title;
  const body = a.content.trim().startsWith("# ") ? a.content.trim() : `# ${finalTitle}\n\n${a.content.trim()}`;
  const r = await ctx.pages.upsert({
    vaultId: v.id,
    path: `inbox/${day}-${slugify(finalTitle)}.md`,
    frontmatter: {
      title: finalTitle,
      type: "note/capture",
      tags: [...new Set(["agente-cloud", ...(a.tags ?? [])])],
      classification: a.classification ?? "interno",
      captured_by: ctx.account.name,
      captured_at: new Date().toISOString(),
    },
    body,
    author: ctx.account.id,
  });
  await ctx.audit?.writeNow({ principalId: ctx.account.id, action: "mcp.capture", resource: r.page.id, ...ctx.meta, data: { vault: v.id, tokens: r.page.tokens } });
  return `Nota salvata: [${r.page.id}] «${finalTitle}» nel vault ${v.name} (\`${v.slug}\`), cartella inbox. Le persone la vedono nell'interfaccia; il ciclo notturno la collega alle altre pagine.`;
}

/**
 * The note as a Markdown source of the vault: ingestion indexes it (I1, I2) and the compiler
 * writes or updates the pages it supports (I3), with citations to the note. The source shows in
 * the inbox of the web interface like an upload; the same text twice is one source.
 */
async function captureAsSource(
  ctx: ToolContext,
  v: { id: string; slug: string; name: string },
  title: string,
  a: { content: string; tags?: string[]; classification?: "pubblico" | "interno" },
): Promise<string> {
  if (!ctx.ingest) throw new ToolError("L'ingestion non è attiva su questo server: salva la nota con compile false.");
  const day = new Date().toISOString().slice(0, 10);
  const tags = [...new Set(["agente", ...(a.tags ?? [])])];
  const body = a.content.trim().startsWith("# ") ? a.content.trim() : `# ${title}\n\n${a.content.trim()}`;
  const front = [`title: ${JSON.stringify(title)}`, `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`, `captured_by: ${JSON.stringify(ctx.account.name)}`];
  const text = `---\n${front.join("\n")}\n---\n${body}\n`;
  const classification = a.classification === "pubblico" ? 0 : 1;
  const r = await ctx.ingest.upload(v.id, Buffer.from(text, "utf8"), `${day}-${slugify(title) || "nota"}.md`, ctx.account.id, { classification, compile: true });
  await ctx.audit?.writeNow({ principalId: ctx.account.id, action: "mcp.capture", resource: r.source.id, ...ctx.meta, data: { vault: v.id, source: true, created: r.created } });
  return r.created
    ? `Nota inviata all'ingestion: documento [${r.source.id}] «${r.source.name}» nel vault ${v.name} (\`${v.slug}\`). HiveVault la indicizza e la compila in pagine con citazioni; il ciclo notturno la collega al resto.`
    : `La stessa nota è già nel vault ${v.name} (\`${v.slug}\`): documento [${r.source.id}] «${r.source.name}». Nessun nuovo invio.`;
}

// ---------------------------------------------------------------------------
// Work journal: session and day notes, always hooked to real pages with [[links]]
// ---------------------------------------------------------------------------

const JOURNAL_TYPE = "note/journal";
const journalDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const bullets = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `- ${x.trim().replace(/^[-*]\s+/, "")}`).join("\n") : "- Niente.");

/**
 * The work journal of an account (plan: "memoria dinamica"). `leggi` returns the latest session
 * and day notes; `sessione` and `giornata` write a note in the inbox of a writable vault with the
 * sections Fatto / Deciso / Aperto. Every note links at least one existing page: a journal note
 * that hangs in the void is refused, and links to pages that do not exist are refused too.
 */
export async function brainJournal(
  ctx: ToolContext,
  a: { action: "leggi" | "sessione" | "giornata"; summary?: string; fatto?: string[]; deciso?: string[]; aperto?: string[]; links?: string[]; vault?: string; limit?: number },
): Promise<string> {
  const p = readerOf(ctx);
  if (a.action === "leggi") {
    const rows = await withReader(ctx.sql, p, (tx) => tx<{ id: string; title: string; body: string; kind: string; updatedAt: Date }[]>`
      select id, title, body, coalesce(frontmatter->>'journal', 'sessione') as kind, updated_at as "updatedAt" from pages
      where vault_id = any(${p.vaults}) and type = ${JOURNAL_TYPE}
      order by updated_at desc limit ${Math.min(a.limit ?? 3, 20)}`);
    if (!rows.length) return "Il diario è vuoto: nessuna nota di sessione o di giornata. Alla fine del lavoro usa brain_journal con action «sessione».";
    return rows
      .map((r) => `## ${r.title} [${r.id}] · ${r.kind} · ${journalDay(r.updatedAt)}\n\n${r.body.replace(/^# [^\n]*\n+/, "").trim()}`)
      .join("\n\n---\n\n");
  }
  if (!canWrite(ctx)) throw new ToolError("Questo account API può solo leggere (serve l'ambito write).");
  const v = await writableVault(ctx, a.vault);
  const links = [...new Set((a.links ?? []).map((l) => l.replace(/^\[\[|\]\]$/g, "").trim()).filter(Boolean))];
  if (!links.length) throw new ToolError("Una nota di diario si aggancia ad almeno una pagina vera: passa links con i titoli di clienti, progetti o persone toccati.");
  const found = await withReader(ctx.sql, p, async (tx) => {
    const out: { link: string; title: string | null }[] = [];
    for (const l of links) out.push({ link: l, title: (await PageStore.resolve(tx, p.vaults, l))[0]?.title ?? null });
    return out;
  });
  const missing = found.filter((f) => !f.title).map((f) => f.link);
  if (missing.length) throw new ToolError(`Queste pagine non esistono: ${missing.join(", ")}. Usa solo pagine che ci sono (brain_search), senza inventarne.`);
  const day = journalDay();
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const ss = String(now.getSeconds()).padStart(2, "0");
  const related = found.map((f) => `[[${f.title}]]`);
  let title: string;
  let path: string;
  let extra = "";
  if (a.action === "sessione") {
    title = `Sessione ${day} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
    path = `inbox/diario/sessioni/sessione-${day}-${hhmm}${ss}.md`;
    // same minute: the title gets the seconds, so links to each session stay distinct
    const [same] = await ctx.sql`select 1 from pages where vault_id = ${v.id} and type = ${JOURNAL_TYPE} and title = ${title}`;
    if (same) title += `:${ss}`;
  } else {
    title = `Giornata ${day}`;
    path = `inbox/diario/giornate/${day}.md`;
    const sessions = await ctx.sql<{ title: string }[]>`
      select title from pages where vault_id = ${v.id} and type = ${JOURNAL_TYPE} and frontmatter->>'journal' = 'sessione' and path like ${`inbox/diario/sessioni/sessione-${day}-%`} order by path`;
    extra = `\n\n## Sessioni\n${sessions.length ? sessions.map((x) => `- [[${x.title}]]`).join("\n") : "- Nessuna nota di sessione oggi."}`;
    related.push(...sessions.map((x) => `[[${x.title}]]`));
  }
  const summary = (a.summary ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  const body = `# ${title}\n\n${summary ? `${summary}\n\n` : ""}## Fatto\n${bullets(a.fatto)}\n\n## Deciso\n${bullets(a.deciso)}\n\n## Aperto\n${bullets(a.aperto)}${extra}\n\n## Collegamenti\n${found.map((f) => `- [[${f.title}]]`).join("\n")}\n`;
  const r = await ctx.pages.upsert({
    vaultId: v.id,
    path,
    frontmatter: {
      title,
      type: JOURNAL_TYPE,
      journal: a.action,
      ...(summary ? { tldr: summary } : {}),
      tags: ["diario", a.action === "sessione" ? "diario/sessione" : "diario/giornata"],
      status: "done",
      created: day,
      updated: day,
      related,
      classification: "interno",
      captured_by: ctx.account.name,
    },
    body,
    author: ctx.account.id,
  });
  await ctx.audit?.writeNow({ principalId: ctx.account.id, action: "mcp.journal", resource: r.page.id, ...ctx.meta, data: { vault: v.id, kind: a.action } });
  return `Nota di diario salvata: [${r.page.id}] «${title}» nel vault ${v.name} (\`${v.slug}\`), cartella inbox/diario. Collegata a ${found.map((f) => f.title).join(", ")}.`;
}

export async function brainProposeEdit(
  ctx: ToolContext,
  a: { page: string; section?: string; text?: string; markdown?: string; rationale: string },
): Promise<string> {
  if (!canWrite(ctx)) throw new ToolError("Questo account API può solo leggere (serve l'ambito write).");
  const p = readerOf(ctx);
  const page = await withReader(ctx.sql, p, async (tx) => (await PageStore.get(tx, a.page)) ?? (await PageStore.resolve(tx, p.vaults, a.page))[0]);
  if (!page) throw new ToolError(`Pagina «${a.page}» non trovata o non accessibile.`);
  if (typeof page.frontmatter.hive_subject === "string" || page.path.startsWith("_inbox/")) {
    throw new ToolError("Questa pagina è scritta dal ciclo notturno: proponi la modifica sulle pagine delle celle da cui deriva.");
  }
  let body: string;
  if (a.markdown) body = a.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  else if (a.section && a.text !== undefined) {
    const s = sections(page.body).find((x) => x.id === a.section || x.title.toLowerCase() === a.section!.toLowerCase());
    if (!s) throw new ToolError(`Sezione «${a.section}» non trovata. Sezioni: ${sections(page.body).map((x) => x.id).join(", ")}.`);
    body = `${page.body.slice(0, s.start)}${a.text.trim()}\n\n${page.body.slice(s.end).replace(/^\n+/, "")}`.trimEnd() + "\n";
  } else throw new ToolError("Passa markdown (pagina intera) oppure section e text.");
  if (body.trim() === page.body.trim()) return "La proposta non cambia la pagina.";
  const fingerprint = createHash("sha256").update(`${page.id}|${page.version}|${body}`).digest("hex").slice(0, 24);
  const item = await upsertCuratorItem(ctx.sql, page.vaultId, "proposal", fingerprint, normalizeTitle(page.title), null, {
    title: page.title,
    pageId: page.id,
    baseVersion: page.version,
    section: a.section ?? null,
    body,
    before: page.body,
    rationale: a.rationale.slice(0, 1000),
    by: ctx.account.name,
    tokens: estimateTokens(body),
  });
  await ctx.sql`update curator_items set page_id = ${page.id} where id = ${item.id}`;
  await ctx.audit?.writeNow({ principalId: ctx.account.id, action: "mcp.propose_edit", resource: page.id, ...ctx.meta, data: { item: item.id, section: a.section ?? null } });
  return `Proposta registrata per [${page.id}] «${page.title}». Una persona con il permesso di cura la approva o la rifiuta nella coda dei curatori; finché non è approvata la pagina non cambia.`;
}
