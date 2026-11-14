// Labels and formatting shared by the views (Italian source text, translated by t()).
import { intlLocale, t } from "./i18n.ts";

/** The clearance ladder: what a person or an API account may read. */
export const CLASSIFICATIONS = ["pubblico", "interno", "riservato", "segreto"] as const;
/** Every level of content: "personale" (4) is read only by the owner of the personal vault. */
export const ALL_CLASSIFICATIONS = [...CLASSIFICATIONS, "personale"] as const;
export const PERSONAL = 4;
export type ClassificationName = (typeof ALL_CLASSIFICATIONS)[number];
export const classificationName = (n: number): ClassificationName => ALL_CLASSIFICATIONS[Math.max(0, Math.min(PERSONAL, n))]!;
/** Levels a person may choose in a vault: "personale" only in their own personal vault. */
export const classificationsFor = (personal: boolean | undefined): readonly ClassificationName[] => (personal ? ALL_CLASSIFICATIONS : CLASSIFICATIONS);

export const VISIBILITIES = ["privato", "team", "azienda"] as const;

/** Display names of the stored values (the values stay Italian: they are data). */
const VALUE_LABEL: Record<string, string> = {
  pubblico: t("pubblico"),
  interno: t("interno"),
  riservato: t("riservato"),
  segreto: t("segreto"),
  personale: t("personale"),
  privato: t("privato"),
  team: t("team"),
  azienda: t("azienda"),
};
export const valueLabel = (v: string | undefined) => (v === undefined ? "" : (VALUE_LABEL[v] ?? v));

/** Sidebar folders, in display order (first part of the page type). */
export const FOLDERS: { id: string; label: string; icon: string }[] = [
  { id: "entity", label: t("Entità"), icon: "◆" },
  { id: "concept", label: t("Concetti"), icon: "◇" },
  { id: "decision", label: t("Decisioni"), icon: "◈" },
  { id: "synthesis", label: t("Sintesi"), icon: "❖" },
  { id: "source", label: t("Sorgenti"), icon: "▤" },
  { id: "note", label: t("Note"), icon: "▫" },
];
const FOLDER_LABEL = new Map(FOLDERS.map((f) => [f.id, f.label]));
export const folderOf = (type: string) => type.split("/")[0] ?? "note";
export const folderLabel = (id: string) => FOLDER_LABEL.get(id) ?? id;

/** Readable type: "entity/company" → "Entità · company". */
export function typeLabel(type: string): string {
  const [f, ...rest] = type.split("/");
  const base = folderLabel(f ?? "note");
  return rest.length ? `${base} · ${rest.join("/")}` : base;
}

export const LEVEL_HINT: Record<string, string> = {
  I1: t("Cercabile per parole chiave"),
  I2: t("Cercabile anche per significato"),
  I3: t("Compilato nel wiki"),
};
/** Short names shown next to the level code (the hint stays in the title). */
export const LEVEL_SHORT: Record<string, string> = {
  I1: t("Parole chiave"),
  I2: t("Significato"),
  I3: t("Compilate"),
};

const dtf = new Intl.DateTimeFormat(intlLocale, { day: "2-digit", month: "2-digit", year: "numeric" });
const tf = new Intl.DateTimeFormat(intlLocale, { hour: "2-digit", minute: "2-digit" });
const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" });

export function shortDate(d: string | Date): string {
  return dtf.format(new Date(d));
}

/** "oggi, 09:12", "ieri, 18:40", "12/09/2026". */
export function when(d: string | Date): string {
  const at = new Date(d);
  const now = new Date();
  const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60000) / 86400000);
  const diff = day(now) - day(at);
  if (diff === 0) return t("oggi, {time}", { time: tf.format(at) });
  if (diff === 1) return t("ieri, {time}", { time: tf.format(at) });
  return dtf.format(at);
}

export function ago(d: string | Date): string {
  const s = (new Date(d).getTime() - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return t("adesso");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export const nf = new Intl.NumberFormat(intlLocale);

const nf1 = new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const dec1 = (n: number) => nf1.format(n);
const nf2 = new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${nf1.format(n / 1024 ** 2)} MB`;
  return `${nf2.format(n / 1024 ** 3)} GB`;
}

export const SOURCE_STATUS: Record<string, { label: string; tone: "busy" | "idle" | "you" | "warn" | "alert" | "dim" }> = {
  stored: { label: t("In coda"), tone: "dim" },
  parsed: { label: t("Letto"), tone: "dim" },
  indexed: { label: t("Cercabile (I1)"), tone: "idle" },
  embedded: { label: t("Cercabile (I2)"), tone: "idle" },
  compiled: { label: t("Compilato (I3)"), tone: "busy" },
  failed: { label: t("Errore"), tone: "alert" },
  unsupported: { label: t("Formato non supportato"), tone: "warn" },
};

export const WARNING_LABEL: Record<string, string> = {
  needs_ocr: t("Serve l'OCR (testo non estraibile)"),
  ocr_unavailable: t("Immagine: OCR non configurato"),
  ocr_truncated: t("OCR solo delle prime pagine (limite OCR_MAX_PAGES)"),
  ocr_failed: t("Alcune pagine non sono state lette dall'OCR (riprova dalla console)"),
  little_text: t("Poco testo estratto"),
};

/** Same normalization as the server (markdown.ts normalizeTitle), for link matching. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
