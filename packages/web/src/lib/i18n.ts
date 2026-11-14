// Translations of the web app. The source language is Italian: the Italian text is the key
// (gettext style), so a missing translation shows the Italian text. The language comes from the
// browser preferences (navigator.languages) and is fixed for the page: no reactive state.
// Catalogs are JSON files in ./i18n, loaded once before the app module (main.ts), so constant
// tables built at import time are translated too.

export const LOCALES = ["it", "en", "fr", "de", "es", "pt"] as const;
export type Locale = (typeof LOCALES)[number];

/** Language used when the browser prefers none of the supported languages. */
export const FALLBACK_LOCALE: Locale = "en";

/** BCP 47 tag for Intl formatters. */
const INTL_TAG: Record<Locale, string> = { it: "it-IT", en: "en-GB", fr: "fr-FR", de: "de-DE", es: "es-ES", pt: "pt-PT" };

/** First supported language in the browser list ("pt-BR" → "pt"), else the fallback. */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0] as Locale;
    if ((LOCALES as readonly string[]).includes(base)) return base;
  }
  return FALLBACK_LOCALE;
}

const browserLanguages = (): readonly string[] => {
  if (typeof navigator === "undefined") return ["it"];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
};

export const locale: Locale = pickLocale(browserLanguages());
/** Locale tag for Intl.* and toLocale*String. Keeps the regional variant of the browser when it matches. */
export const intlLocale: string = (() => {
  const exact = browserLanguages().find((l) => l.toLowerCase().split(/[-_]/)[0] === locale);
  return exact && exact.includes("-") ? exact : INTL_TAG[locale];
})();

let catalog: Record<string, string> = {};

const loaders: Record<Exclude<Locale, "it">, () => Promise<{ default: Record<string, string> }>> = {
  en: () => import("./i18n/en.json"),
  fr: () => import("./i18n/fr.json"),
  de: () => import("./i18n/de.json"),
  es: () => import("./i18n/es.json"),
  pt: () => import("./i18n/pt.json"),
};

/** Loads the catalog of the browser language and sets <html lang>. Call before the app module loads. */
export async function loadLocale(): Promise<void> {
  // no DOM types here: the root lint checks this file through the tests
  const root = (globalThis as { document?: { documentElement: { lang: string } } }).document?.documentElement;
  if (root) root.lang = locale;
  if (locale === "it") return;
  try {
    catalog = (await loaders[locale]()).default;
  } catch {
    catalog = {}; // the Italian text stays readable
  }
}

/** For tests. */
export function setCatalog(c: Record<string, string>): void {
  catalog = c;
}

/**
 * Translates an Italian UI text. `{name}` placeholders take their values from `vars`.
 * The key must be a string literal: the catalog test reads the keys from the source.
 */
export function t(key: string, vars?: Record<string, string | number | null | undefined>): string {
  const s = catalog[key] || key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m));
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/**
 * Like t(), for one sentence with emphasis, as safe HTML for {@html}: the text and the values
 * are escaped first, then **x** becomes <strong>, [x] becomes <kbd>, `x` becomes a mono span.
 * Translators keep the markers, so the sentence is never split into fragments.
 */
export function tHtml(key: string, vars?: Record<string, string | number | null | undefined>): string {
  // markers first, values last: a value with [x] or **x** stays plain text
  return escapeHtml(catalog[key] || key)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]/g, "<kbd>$1</kbd>")
    .replace(/`([^`]+)`/g, '<span class="mono">$1</span>')
    .replace(/\{(\w+)\}/g, (m, k: string) => (vars && k in vars ? escapeHtml(String(vars[k] ?? "")) : m));
}

/**
 * Lowercases the first letter of a label used inside a sentence. German keeps the capital of
 * nouns; an acronym ("OCR …") stays as it is.
 */
export const inSentence = (label: string): string => {
  if (locale === "de" || !label || /^\p{Lu}{2}/u.test(label)) return label;
  return label[0]!.toLocaleLowerCase(intlLocale) + label.slice(1);
};
