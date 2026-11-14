/**
 * Structured extraction (M2): the model reads one part of a source and answers with JSON —
 * entities, "Label: value" facts and dated events, each with the id of the chunk it comes
 * from. The code merges them into the wiki pages; the model never writes Markdown.
 *
 * Compared with the agent (16 turns, the whole page written again at every update) one call
 * per part costs a fraction of the tokens, the calls of the parts are independent (several
 * chat endpoints serve them in parallel), and a merge never loses what a page said before:
 *
 * - a new fact is a new bullet of "## Stato attuale";
 * - the same value again only adds the citation;
 * - another value: the newer document wins (the old value goes to "## Timeline"); an older
 *   document only adds a Timeline event; without dates both values stay in a conflict block.
 */
import { normalizeTitle } from "@cb/brain";
import { normalizePredicate, normalizeValue } from "@cb/hive";
import { dedupKey } from "./names.ts";

export const ENTITY_TYPES = ["entity/person", "entity/company", "entity/project", "entity/product", "concept", "decision"] as const;

export const EXTRACT_SYSTEM = [
  "Estrai la conoscenza di un documento aziendale per un wiki. Rispondi solo con JSON, senza testo prima o dopo.",
  'Formato: {"entities": [{"title": "...", "type": "...", "aliases": ["..."], "tldr": "...", "facts": [{"label": "...", "value": "...", "chunk": 3}], "events": [{"date": "AAAA-MM-GG", "text": "...", "chunk": 3}]}]}',
  `type: uno di ${ENTITY_TYPES.join(", ")}.`,
  "Regole:",
  "1. Solo persone, aziende, progetti, prodotti, concetti e decisioni rilevanti per l'azienda. Niente entità generiche.",
  "2. title: il nome completo (con la forma giuridica per le aziende). Se l'entità è tra le pagine esistenti, usa esattamente quel titolo.",
  "3. facts: lo stato attuale, un fatto per voce. Ogni numero, data, nome o condizione che descrive come stanno le cose è un fatto (anche se il testo lo dice in un evento). label breve (Ruolo, Referente tecnico, Postazioni, Scadenza del contratto, Database ...), value breve e preciso: numeri, date e nomi come nel testo.",
  "4. I fatti di un contratto, un ordine o un'offerta (postazioni, scadenza, canone, referenti) vanno sull'azienda cliente, non sul prodotto. Se riguardano un prodotto, scrivi il prodotto nella label: \"Postazioni Orbit Analytics\", \"Scadenza del contratto Atlas ERP\". Un prodotto ha solo i fatti del prodotto stesso.",
  "5. Un fatto che cambia (\"da 850 a 975\") ha il valore nuovo: 975.",
  "6. events: fatti datati (riunioni, ordini, offerte, rinnovi). date in formato AAAA-MM-GG; senza giorno nel testo usa la data del documento.",
  "7. chunk: il numero della parte [cN] da cui viene il fatto. Niente fatti senza chunk, niente fatti che il testo non dice.",
  "8. tldr: una frase, al massimo 200 caratteri. Scrivi in italiano.",
  '9. Se il messaggio elenca delle sezioni, aggiungi "sections": [{"chunk": 3, "text": "..."}] con una frase per ogni sezione: di cosa parla e i dati principali, al massimo 200 caratteri. chunk è il numero della sezione.',
].join("\n");

export interface ExtractedFact {
  label: string;
  value: string;
  chunk: number;
}
export interface ExtractedEvent {
  date: string;
  text: string;
  chunk: number;
}
export interface ExtractedEntity {
  title: string;
  type: string;
  aliases: string[];
  tldr: string;
  facts: ExtractedFact[];
  events: ExtractedEvent[];
}

const oneLine = (s: unknown, max: number) =>
  String(s ?? "")
    .replace(/\^\[[^\]]*\]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The entities of a model answer, cleaned: unknown chunk ids, empty values, broken types and
 * dates are dropped (a fact must have a chunk to cite). Null when the answer is not JSON.
 */
export function parseExtraction(text: string, chunks: Set<number>, o: { maxEntities?: number; maxFacts?: number } = {}): ExtractedEntity[] | null {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  const m = /\{[\s\S]*\}/.exec(clean);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const list = (raw as { entities?: unknown })?.entities;
  if (!Array.isArray(list)) return null;
  const chunkOf = (x: unknown) => {
    const n = Number(String(x ?? "").replace(/^c/i, ""));
    return Number.isInteger(n) && chunks.has(n) ? n : null;
  };
  const out: ExtractedEntity[] = [];
  for (const e of list.slice(0, o.maxEntities ?? 12)) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const title = oneLine(r.title, 150).replace(/[[\]|#^]/g, "");
    if (title.length < 2) continue;
    const type = (ENTITY_TYPES as readonly string[]).includes(String(r.type)) ? String(r.type) : "concept";
    const facts: ExtractedFact[] = [];
    for (const f of Array.isArray(r.facts) ? r.facts.slice(0, o.maxFacts ?? 15) : []) {
      const x = (f ?? {}) as Record<string, unknown>;
      const label = oneLine(x.label, 60).replace(/[:[\]]/g, "");
      const value = oneLine(x.value, 200);
      const chunk = chunkOf(x.chunk);
      if (label.length >= 2 && value && chunk !== null) facts.push({ label, value, chunk });
    }
    const events: ExtractedEvent[] = [];
    for (const v of Array.isArray(r.events) ? r.events.slice(0, o.maxFacts ?? 15) : []) {
      const x = (v ?? {}) as Record<string, unknown>;
      const date = oneLine(x.date, 10);
      const txt = oneLine(x.text, 240);
      const chunk = chunkOf(x.chunk);
      if (ISO_DATE.test(date) && txt && chunk !== null) events.push({ date, text: txt, chunk });
    }
    if (!facts.length && !events.length) continue;
    const aliases = (Array.isArray(r.aliases) ? r.aliases : []).map((a) => oneLine(a, 150).replace(/[[\]|#^]/g, "")).filter((a) => a.length >= 2 && a !== title);
    out.push({ title, type, aliases: [...new Set(aliases)].slice(0, 8), tldr: oneLine(r.tldr, 240), facts, events });
  }
  return out;
}

/**
 * One sentence for every section of a long document (M8), by the chunk the section starts at.
 * Sections the model did not describe are absent.
 */
export function parseSections(text: string, starts: Set<number>): Map<number, string> {
  const out = new Map<number, string>();
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  const m = /\{[\s\S]*\}/.exec(clean);
  if (!m) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return out;
  }
  const list = (raw as { sections?: unknown })?.sections;
  for (const x of Array.isArray(list) ? list : []) {
    const r = (x ?? {}) as Record<string, unknown>;
    const n = Number(String(r.chunk ?? "").replace(/^c/i, ""));
    const t = oneLine(r.text, 240);
    if (Number.isInteger(n) && starts.has(n) && t.length >= 10 && !out.has(n)) out.set(n, t);
  }
  return out;
}

/**
 * Entities of several parts with the same name are one entity; so are two entities of one
 * type whose titles differ only in the legal form or a generic word ("X S.p.A.", "X Group"), M6.
 */
export function mergeEntities(lists: ExtractedEntity[][]): ExtractedEntity[] {
  const byKey = new Map<string, ExtractedEntity>();
  const keyOf = new Map<string, string>();
  for (const e of lists.flat()) {
    const all = [e.title, ...e.aliases];
    const names = [
      ...all.map(normalizeTitle).filter(Boolean),
      ...all.map((n) => dedupKey(n, e.type)).filter((k): k is string => !!k).map((k) => `${e.type}\u0000${k}`),
    ];
    const key = names.map((n) => keyOf.get(n)).find(Boolean) ?? normalizeTitle(e.title);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...e, aliases: [...e.aliases], facts: [...e.facts], events: [...e.events] });
    else {
      prev.aliases = [...new Set([...prev.aliases, ...e.aliases, ...(e.title !== prev.title ? [e.title] : [])])];
      prev.facts.push(...e.facts);
      prev.events.push(...e.events);
      if (!prev.tldr) prev.tldr = e.tldr;
    }
    for (const n of names) if (!keyOf.has(n)) keyOf.set(n, key);
  }
  return [...byKey.values()];
}

export interface MergeInput {
  /** The page as it is, or null for a new page. */
  existing: { frontmatter: Record<string, unknown>; body: string } | null;
  entity: ExtractedEntity;
  sourceId: string;
  /** Date of the source (YYYY-MM-DD), or null. */
  sourceDate: string | null;
  /** Dates (YYYY-MM-DD) of the sources the page cites already, by source id. */
  citedDates: Map<string, string>;
  /** Normalized names of pages a value can link to: "Referente tecnico: [[Vittoria Serra]]". */
  linkable: Map<string, string>;
}

export interface MergeOutput {
  frontmatter: Record<string, unknown>;
  body: string;
  added: number;
  updated: number;
  conflicts: number;
  events: number;
}

const BULLET = /^(\s*[-*+]\s+)(.+?)\s*$/;
const KV = /^([^:[\]]{2,60}?):\s+(.+)$/;
const CITE = /\^\[([^\]#\n]+)(?:#[^\]\n]*)?\]/g;

/** "Label: value ^[a] ^[b]" → its parts; null for a line that is not a "Label: value" bullet. */
function parseBullet(line: string): { label: string; value: string; cites: string[]; sources: string[] } | null {
  const m = BULLET.exec(line);
  if (!m) return null;
  const cites = [...m[2]!.matchAll(/\^\[[^\]\n]+\]/g)].map((x) => x[0]);
  const sources = [...m[2]!.matchAll(CITE)].map((x) => x[1]!);
  const text = m[2]!.replace(/\s?\^\[[^\]\n]*\]/g, "").replace(/\*\*|__/g, "").trim();
  const kv = KV.exec(text);
  return kv ? { label: kv[1]!.trim(), value: kv[2]!.trim(), cites, sources } : null;
}

/** Lines of the level-2 section `title` and where they are, or null. */
function findSection(lines: string[], title: RegExp): { head: number; end: number } | null {
  const head = lines.findIndex((l) => /^##\s+/.test(l) && title.test(l.replace(/^##\s+/, "").trim()));
  if (head < 0) return null;
  let end = head + 1;
  while (end < lines.length && !/^#{1,2}\s+/.test(lines[end]!)) end++;
  return { head, end };
}

const STATE = /^stato attuale$/i;
const TIMELINE = /^timeline$/i;

/** The page with the facts and events of one entity merged in. Deterministic. */
export function mergePage(i: MergeInput): MergeOutput {
  const e = i.entity;
  const cite = (chunk: number) => `^[${i.sourceId}#c${chunk}]`;
  const link = (value: string) => {
    const target = i.linkable.get(normalizeTitle(value));
    return target && !value.includes("[[") ? (target === value ? `[[${value}]]` : `[[${target}|${value}]]`) : value;
  };
  const fm: Record<string, unknown> = i.existing ? { ...i.existing.frontmatter } : { title: e.title, type: e.type };
  const known = new Set([fm.title, ...(Array.isArray(fm.aliases) ? fm.aliases : [])].map((x) => normalizeTitle(String(x ?? ""))));
  const aliases = [...(Array.isArray(fm.aliases) ? (fm.aliases as string[]) : []), ...[e.title, ...e.aliases].filter((a) => !known.has(normalizeTitle(a)))];
  if (aliases.length) fm.aliases = [...new Set(aliases)];
  if (!fm.tldr && e.tldr.length >= 20) fm.tldr = e.tldr;

  const lines = (i.existing?.body ?? `# ${e.title}\n`).replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  let state = findSection(lines, STATE);
  if (!state) {
    // after the title and the text before the first section
    let at = lines.findIndex((l, n) => n > 0 && /^##\s+/.test(l));
    if (at < 0) at = lines.length;
    lines.splice(at, 0, "", "## Stato attuale", "");
    state = findSection(lines, STATE)!;
  }

  // facts: one per predicate, the newest document wins
  const out: MergeOutput = { frontmatter: fm, body: "", added: 0, updated: 0, conflicts: 0, events: 0 };
  const moved: string[] = [];
  const conflicts: string[] = [];
  const newBullets: string[] = [];
  const seen = new Set<string>();
  const newest = (sources: string[]) => sources.map((s) => i.citedDates.get(s)).filter((d): d is string => !!d).sort().at(-1) ?? null;
  for (const f of e.facts) {
    const pred = normalizePredicate(f.label);
    const val = normalizeValue(f.value);
    if (!pred || !val || seen.has(`${pred}\u0000${val}`)) continue;
    seen.add(`${pred}\u0000${val}`);
    let idx = -1;
    let cur: ReturnType<typeof parseBullet> = null;
    for (let n = state.head + 1; n < state.end; n++) {
      const b = parseBullet(lines[n]!);
      if (b && normalizePredicate(b.label) === pred) {
        idx = n;
        cur = b;
        break;
      }
    }
    const bullet = `- ${f.label}: ${link(f.value)} ${cite(f.chunk)}`;
    if (!cur) {
      const pending = newBullets.findIndex((b) => normalizePredicate(parseBullet(b)!.label) === pred);
      if (pending < 0) {
        newBullets.push(bullet);
        out.added++;
      }
      continue;
    }
    if (normalizeValue(cur.value) === val) {
      if (!lines[idx]!.includes(cite(f.chunk))) lines[idx] = `${lines[idx]!.replace(/\s+$/, "")} ${cite(f.chunk)}`;
      continue;
    }
    const before = newest(cur.sources);
    if (i.sourceDate && before && i.sourceDate > before) {
      lines[idx] = bullet;
      moved.push(`- ${i.sourceDate} · ${cur.label}: ${cur.value} → ${f.value} ${cite(f.chunk)}`);
      out.updated++;
    } else if (i.sourceDate && before && i.sourceDate < before) {
      moved.push(`- ${i.sourceDate} · ${f.label}: ${f.value} ${cite(f.chunk)}`);
    } else {
      conflicts.push(`> [!conflict] ${cur.label}`, `> - ${cur.value} ${cur.cites.join(" ")}`.trimEnd(), `> - ${f.value} ${cite(f.chunk)}`, "");
      out.conflicts++;
    }
  }
  if (conflicts.length) {
    let at = state.end;
    while (at > state.head + 1 && !lines[at - 1]!.trim()) at--;
    lines.splice(at, 0, "", ...conflicts);
  }
  if (newBullets.length) {
    // after the last bullet of the section (before the conflict blocks)
    let at = state.head + 1;
    for (let n = state.head + 1; n < state.end + conflicts.length + 1 && n < lines.length; n++) if (BULLET.test(lines[n]!) && !/^\s*>/.test(lines[n]!)) at = n + 1;
    lines.splice(at, 0, ...(at === state.head + 1 ? ["", ...newBullets] : newBullets));
  }

  // events: newest first, one per date and text
  const events = [...moved, ...e.events.map((v) => `- ${v.date} · ${v.text} ${cite(v.chunk)}`)];
  if (events.length) {
    let tl = findSection(lines, TIMELINE);
    if (!tl) {
      const st = findSection(lines, STATE)!;
      let at = st.end;
      while (at > st.head + 1 && !lines[at - 1]!.trim()) at--;
      lines.splice(at, 0, "", "## Timeline", "");
      tl = findSection(lines, TIMELINE)!;
    }
    const body = lines.slice(tl.head + 1, tl.end);
    const keyOf = (l: string) => normalizeValue(l.replace(/\s?\^\[[^\]\n]*\]/g, "").replace(/^\s*[-*+]\s+/, ""));
    const have = new Set(body.map(keyOf));
    const entries = body.filter((l) => l.trim());
    for (const ev of events) {
      if (have.has(keyOf(ev))) continue;
      have.add(keyOf(ev));
      entries.push(ev);
      out.events++;
    }
    const dateOf = (l: string) => /^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})/.exec(l)?.[1] ?? "";
    // dated bullets newest first; other lines keep their place at the end
    const dated = entries.filter((l) => dateOf(l)).sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    const other = entries.filter((l) => !dateOf(l));
    lines.splice(tl.head + 1, tl.end - tl.head - 1, "", ...dated, ...other, "");
  }
  out.body = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  return out;
}
