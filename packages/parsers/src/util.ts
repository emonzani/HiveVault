import type { Lang } from "./types.ts";

// ---------------------------------------------------------------------------
// Language: Italian or English by function words (enough to pick the stemmer).
// ---------------------------------------------------------------------------
const IT = new Set("il lo la gli le un una di da del della dei delle che non per con nel nella sono è e ma come anche questo questa al alla ai ha hanno più se ci si".split(" "));
const EN = new Set("the of and to in is that it for on with as was are be this by at from or an have not which you we they has".split(" "));

export function detectLang(text: string): Lang {
  const words = text.slice(0, 8000).toLowerCase().match(/\p{L}+/gu) ?? [];
  let it = 0;
  let en = 0;
  for (const w of words) {
    if (IT.has(w)) it++;
    else if (EN.has(w)) en++;
  }
  if (it + en < 5) return "simple";
  return it >= en ? "italian" : "english";
}

/** UTF-8 when valid (with or without BOM), else Windows-1252: the usual legacy encoding here. */
export function decodeText(data: Buffer): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString("utf8");
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

export function truncate(md: string, maxChars: number, warnings: string[]): string {
  if (md.length <= maxChars) return md;
  warnings.push("truncated");
  const cut = md.lastIndexOf("\n", maxChars);
  return md.slice(0, cut > maxChars * 0.8 ? cut : maxChars) + "\n\n> Testo troncato: il documento supera il limite di estrazione.\n";
}

export const escapeCell = (v: unknown) =>
  String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();

export function markdownTable(header: string[], rows: unknown[][]): string {
  const h = header.map((x, i) => escapeCell(x) || `Colonna ${i + 1}`);
  return [`| ${h.join(" | ")} |`, `|${h.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${h.map((_, i) => escapeCell(r[i])).join(" | ")} |`)].join("\n");
}

/**
 * A table becomes Markdown when it is small. A large table (thousands of rows) becomes a
 * description: columns with type, distinct values, range and examples, plus the first rows.
 * The full data stays in the original file; the text is what search and the model need.
 */
export function describeTable(header: string[], rows: unknown[][], o: { maxRows?: number; sample?: number } = {}): { markdown: string; meta: Record<string, unknown> } {
  const maxRows = o.maxRows ?? 200;
  const meta = { rows: rows.length, columns: header.length };
  if (rows.length <= maxRows) return { markdown: markdownTable(header, rows), meta };
  const cols = header.map((name, i) => {
    const values = rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined && v !== "");
    const nums = values.map((v) => (typeof v === "number" ? v : Number(String(v).replace(/\./g, "").replace(",", ".")))).filter((n) => Number.isFinite(n));
    const isNum = values.length > 0 && nums.length / values.length > 0.9;
    const distinct = new Set(values.map((v) => String(v)));
    const examples = [...distinct].slice(0, 3).map((x) => x.slice(0, 40));
    const range = isNum ? `${Math.min(...nums).toLocaleString("it-IT")} – ${Math.max(...nums).toLocaleString("it-IT")}` : "";
    return [name || `Colonna ${i + 1}`, isNum ? "numero" : "testo", values.length, distinct.size, range, examples.join("; ")];
  });
  const sample = o.sample ?? 20;
  return {
    markdown: [
      `Tabella di ${rows.length.toLocaleString("it-IT")} righe e ${header.length} colonne. Il testo riporta la struttura e le prime ${sample} righe; i dati completi sono nel file originale.`,
      "",
      markdownTable(["Colonna", "Tipo", "Valori", "Distinti", "Intervallo", "Esempi"], cols),
      "",
      `Prime ${sample} righe:`,
      "",
      markdownTable(header, rows.slice(0, sample)),
    ].join("\n"),
    meta: { ...meta, summarized: true },
  };
}

export const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
