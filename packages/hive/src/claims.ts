/**
 * Claims (plan §3.2, §3.5): atomic statements taken from the "Stato attuale" (compiled truth)
 * of a page. One bullet gives one claim:
 *
 *   - Referente tecnico: [[Nome Cognome]] ^[src#c0]              → predicate "referente tecnico"
 *   - Usa [[Azienda esempio]] con **250 postazioni** ^[…]        → predicate "postazioni", value "250"
 *   - Il cliente valuta il rinnovo anticipato                     → note (predicate "_"): never a conflict
 *
 * The extraction is deterministic: compiled pages follow the "Label: value" convention of the
 * compiler prompt, so the same page gives the same claims every night. `syncClaims` keeps the
 * table equal to the pages: new bullets become claims, removed bullets are retracted, and the
 * retraction reaches the hive at the next promotion.
 */
import { createHash } from "node:crypto";
import type { Sql } from "@cb/db";
import { extractCitations, maskCode, normalizeTitle, PERSONAL, sections } from "@cb/brain";
import { newId } from "@cb/shared";

export const NOTE = "_";

export interface ExtractedClaim {
  blockId: string;
  predicate: string;
  /** Value as written (wikilinks kept, citations and emphasis removed). */
  value: string;
  valueNorm: string;
  cites: string[];
  observedAt: string | null;
}

const CURRENT = /^(stato attuale|stato|current state|summary|sintesi)$/i;

/** Labels with the same meaning share one predicate. */
const SYNONYMS: Record<string, string> = {
  "numero di postazioni": "postazioni",
  "posti": "postazioni",
  "licenze": "postazioni",
  "seats": "postazioni",
  "rinnovo del contratto": "rinnovo",
  "scadenza del contratto": "rinnovo",
  "scadenza": "rinnovo",
  "data di rinnovo": "rinnovo",
  "referente it": "referente tecnico",
  "contatto tecnico": "referente tecnico",
  "contatto commerciale": "referente commerciale",
  "responsabile del progetto": "responsabile",
  "project manager": "responsabile",
  "pm": "responsabile",
  "db": "database",
  "consegna": "consegna prevista",
  "data di consegna": "consegna prevista",
};

/**
 * Synonyms of more than one word also as the start of a label (M18): the extraction writes the
 * product in the label of a contract fact ("Numero di postazioni Orbit Analytics"), which is the
 * predicate "postazioni orbit analytics" of "Postazioni Orbit Analytics". One-word synonyms stay
 * exact: "posti auto" is not "postazioni auto".
 */
const PREFIXES = Object.keys(SYNONYMS)
  .filter((k) => k.includes(" "))
  .sort((a, b) => b.length - a.length);

export function normalizePredicate(label: string): string {
  const n = normalizeTitle(label.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, d?: string) => d ?? t));
  if (SYNONYMS[n]) return SYNONYMS[n];
  const k = PREFIXES.find((p) => n.startsWith(`${p} `));
  return k ? `${SYNONYMS[k]}${n.slice(k.length)}` : n;
}

/** Plain text of a value: wikilinks become their label, numbers lose thousand separators. */
export function normalizeValue(value: string): string {
  const plain = value
    .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, d?: string) => d ?? t)
    .replace(/(\d)[.\s](?=\d{3}\b)/g, "$1")
    .replace(/(\d),(\d)/g, "$1.$2");
  return normalizeTitle(plain);
}

const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const IT = /\b(\d{2})\/(\d{2})\/(\d{4})\b/;
function dateOf(text: string): string | null {
  const a = ISO.exec(text);
  if (a) return `${a[1]}-${a[2]}-${a[3]}`;
  const b = IT.exec(text);
  return b ? `${b[3]}-${b[2]}-${b[1]}` : null;
}

/** "250 postazioni", "1.200 utenti": a number followed by a counted noun. */
const COUNT = /(?<![\w.,])(\d{1,3}(?:[.\s]\d{3})+|\d+)\s+(?:\*\*)?([a-zàèéìòù][a-zàèéìòù]{3,})/i;
/** Nouns that follow a number but do not name what is counted. */
const NOT_COUNTED = new Set(["euro", "mese", "mesi", "anni", "anno", "giorni", "giorno", "volte", "percento", "circa", "settimane", "ore"]);

export function extractClaims(body: string): ExtractedClaim[] {
  const masked = maskCode(body);
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  for (const s of sections(masked)) {
    if (!CURRENT.test(s.title)) continue;
    const text = body.slice(s.start, s.end);
    for (const line of text.split("\n")) {
      const m = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
      if (!m) continue;
      const raw = m[1]!;
      const cites = extractCitations(raw).map((c) => c.ref);
      const clean = raw
        .replace(/\s?\^\[[^\]\n]*\]/g, "")
        .replace(/\*\*|__/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!clean) continue;
      let predicate = NOTE;
      let value = clean;
      const kv = /^([^:[\]]{2,60}?):\s+(.+)$/.exec(clean);
      if (kv) {
        predicate = normalizePredicate(kv[1]!);
        value = kv[2]!.trim();
      } else {
        const c = COUNT.exec(clean);
        if (c && !NOT_COUNTED.has(c[2]!.toLowerCase())) {
          predicate = normalizePredicate(c[2]!);
          value = c[1]!;
        }
      }
      const valueNorm = normalizeValue(value);
      if (!predicate || !valueNorm) continue;
      const key = `${predicate}\u0000${valueNorm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ blockId: s.id, predicate, value, valueNorm, cites, observedAt: dateOf(clean) });
    }
  }
  return out;
}

export interface SyncResult {
  pages: number;
  added: number;
  retracted: number;
  kept: number;
}

/**
 * Brings the claims of some pages in line with their text. Pages: explicit ids, or the pages
 * of the vaults changed since their last sync (`pages.claims_at`, partial index).
 */
export async function syncClaims(sql: Sql, o: { vaultIds: string[]; pageIds?: string[]; limit?: number }): Promise<SyncResult> {
  const res: SyncResult = { pages: 0, added: 0, retracted: 0, kept: 0 };
  type Row = { id: string; vaultId: string; title: string; body: string; classification: number; visibility: number; confidence: number | null; updatedAt: string };
  const pages = o.pageIds
    ? await sql<Row[]>`
        select id, vault_id as "vaultId", title, body, classification, visibility, confidence, updated_at::text as "updatedAt"
        from pages where id = any(${o.pageIds})`
    : await sql<Row[]>`
        select id, vault_id as "vaultId", title, body, classification, visibility, confidence, updated_at::text as "updatedAt"
        from pages
        where vault_id = any(${o.vaultIds}) and (claims_at is null or claims_at < updated_at)
        order by id limit ${o.limit ?? 5000}`;
  // claims of deleted pages go with them (on delete cascade)
  for (const p of pages) {
    res.pages++;
    // "personale": never promoted, no claims at all (not even retracted ones with its text)
    if (p.classification === PERSONAL) {
      const r = await sql`delete from claims where page_id = ${p.id}`;
      res.retracted += r.count;
      await sql`update pages set claims_at = ${p.updatedAt}::text::timestamptz where id = ${p.id}`;
      continue;
    }
    const found = await withSourceDates(sql, extractClaims(p.body));
    await sql.begin(async (tx) => {
      const old = await tx<{ id: string; predicate: string; valueNorm: string; status: string }[]>`
        select id, predicate, value_norm as "valueNorm", status from claims where page_id = ${p.id}`;
      const byKey = new Map(old.map((c) => [`${c.predicate}\u0000${c.valueNorm}`, c]));
      const subjectNorm = normalizeTitle(p.title);
      for (const c of found) {
        const prev = byKey.get(`${c.predicate}\u0000${c.valueNorm}`);
        byKey.delete(`${c.predicate}\u0000${c.valueNorm}`);
        if (prev) {
          await tx`
            update claims set status = 'active', value = ${c.value}, block_id = ${c.blockId}, cites = ${c.cites}, observed_at = ${c.observedAt},
                   subject = ${p.title}, subject_norm = ${subjectNorm}, classification = ${p.classification}, visibility = ${p.visibility},
                   confidence = ${p.confidence}, updated_at = now()
            where id = ${prev.id}`;
          res.kept++;
        } else {
          await tx`
            insert into claims (id, vault_id, page_id, block_id, subject, subject_norm, predicate, value, value_norm, cites, observed_at,
                                confidence, classification, visibility)
            values (${newId("clm")}, ${p.vaultId}, ${p.id}, ${c.blockId}, ${p.title}, ${subjectNorm}, ${c.predicate}, ${c.value}, ${c.valueNorm},
                    ${c.cites}, ${c.observedAt}, ${p.confidence}, ${p.classification}, ${p.visibility})`;
          res.added++;
        }
      }
      // bullets no longer on the page: retracted (kept for the history of the conflicts)
      const gone = [...byKey.values()].filter((c) => c.status === "active").map((c) => c.id);
      if (gone.length) {
        await tx`update claims set status = 'retracted', updated_at = now() where id = any(${gone})`;
        res.retracted += gone.length;
      }
      // the page is synced as of the text read above (a later edit is picked up next time);
      // the time goes back as text: a timestamptz parameter would pass through a JS Date and lose the microseconds
      await tx`update pages set claims_at = ${p.updatedAt}::text::timestamptz where id = ${p.id}`;
    });
  }
  return res;
}

export const claimHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/**
 * M18: a claim without a date in its text is observed when its newest cited document was written
 * (`sources.meta.date` or `meta.created`, the dates the compiler orders values by). The conflict
 * blocks of the hive then say which value is more recent.
 */
export async function withSourceDates(sql: Sql, claims: ExtractedClaim[]): Promise<ExtractedClaim[]> {
  const ids = [...new Set(claims.filter((c) => !c.observedAt).flatMap((c) => c.cites.map((r) => r.split("#")[0]!).filter((r) => r.startsWith("src_"))))];
  if (!ids.length) return claims;
  const dates = new Map<string, string>();
  for (const r of await sql<{ id: string; d: string | null }[]>`select id, coalesce(meta->>'date', meta->>'created') as d from sources where id = any(${ids})`) {
    const d = /^\d{4}-\d{2}-\d{2}/.exec(r.d ?? "")?.[0];
    if (d) dates.set(r.id, d);
  }
  return claims.map((c) => {
    if (c.observedAt) return c;
    const d = c.cites.map((r) => dates.get(r.split("#")[0]!)).filter((x): x is string => !!x).sort().at(-1);
    return d ? { ...c, observedAt: d } : c;
  });
}
