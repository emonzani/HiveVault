import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inSentence, LOCALES, pickLocale, setCatalog, t, tHtml } from "../src/lib/i18n.ts";
import { collectKeys, placeholders } from "./i18n-keys.ts";

const SRC = join(import.meta.dirname, "..", "src");
const keys = collectKeys(SRC);
const markers = (s: string) => [(s.match(/\*\*/g) ?? []).length, (s.match(/\[/g) ?? []).length, (s.match(/`/g) ?? []).length];

describe("translation catalogs", () => {
  it("finds the keys in the source", () => {
    expect(keys.size).toBeGreaterThan(1000);
    expect(keys.has("Accedi")).toBe(true);
  });

  for (const locale of LOCALES.filter((l) => l !== "it")) {
    describe(locale, () => {
      const catalog = JSON.parse(readFileSync(join(SRC, "lib", "i18n", `${locale}.json`), "utf8")) as Record<string, string>;

      it("translates every key of the source and nothing else", () => {
        const missing = [...keys].filter((k) => !catalog[k]);
        const extra = Object.keys(catalog).filter((k) => !keys.has(k));
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });

      it("keeps the placeholders and the emphasis markers", () => {
        const bad = Object.entries(catalog).filter(
          ([k, v]) => placeholders(k).join() !== placeholders(v).join() || markers(k).join() !== markers(v).join(),
        );
        expect(bad).toEqual([]);
      });
    });
  }
});

describe("i18n runtime", () => {
  it("picks the first supported browser language, else English", () => {
    expect(pickLocale(["de-CH", "en-US"])).toBe("de");
    expect(pickLocale(["pt-BR"])).toBe("pt");
    expect(pickLocale(["nl-NL", "fr"])).toBe("fr");
    expect(pickLocale(["it-IT"])).toBe("it");
    expect(pickLocale(["nl-NL", "ja"])).toBe("en");
    expect(pickLocale([])).toBe("en");
  });

  it("falls back to the Italian text and fills placeholders", () => {
    setCatalog({ "Ciao {name}": "Hello {name}" });
    expect(t("Ciao {name}", { name: "Ada" })).toBe("Hello Ada");
    expect(t("Non tradotto")).toBe("Non tradotto");
    setCatalog({});
  });

  it("escapes text and values before adding emphasis (no raw HTML from content)", () => {
    setCatalog({ "Pagina **{x}**": "Page **{x}** <b>[Invio]</b>" });
    const html = tHtml("Pagina **{x}**", { x: "<img src=x onerror=alert(1)>" });
    expect(html).toBe("Page <strong>&lt;img src=x onerror=alert(1)&gt;</strong> &lt;b&gt;<kbd>Invio</kbd>&lt;/b&gt;");
    setCatalog({});
  });

  it("does not turn markers inside values into markup", () => {
    expect(tHtml("Vault **{x}**", { x: "[Ctrl] **a**" })).toBe("Vault <strong>[Ctrl] **a**</strong>");
  });

  it("lowercases only the first letter of a label inside a sentence", () => {
    // the test runtime has no navigator: the locale is Italian
    expect(inSentence("Ultime 24 ore")).toBe("ultime 24 ore");
    expect(inSentence("OCR in corso")).toBe("OCR in corso");
    expect(inSentence("")).toBe("");
  });
});
