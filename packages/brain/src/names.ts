/**
 * Other names of a page: short forms of standard names, and the code of a document. Links
 * and the dream crosslink step use them to find a page by the name people write.
 */

const ISSUERS = "ETSI|CENELEC|CEN|UNI|CEI|DIN|BS|NF|ÖNORM|EN|ISO\\/IEC|ISO|IEC|IEEE|ANSI|NIST";
/** Issuing bodies written before a standard code: "ETSI EN 319 522-2" is also cited as "EN 319 522-2". */
const ISSUER = new RegExp(`^(?:${ISSUERS})\\s+(?=\\p{Lu})`, "u");

/**
 * Short forms of a standard name, without its issuing bodies: "UNI EN ISO 9001" →
 * "EN ISO 9001", "ISO 9001". A short form must still start with a capital letter and
 * contain a number, so "ISO/IEC 27001" gives no "27001".
 */
export function shortForms(name: string): string[] {
  const out: string[] = [];
  let n = name.trim();
  for (let m = ISSUER.exec(n); m; m = ISSUER.exec(n)) {
    n = n.slice(m[0].length);
    if (/\d/.test(n)) out.push(n);
  }
  return out;
}

/** A code: capital letters (words like "EN", "ISO/IEC", "RFC"), then numbers: "EN 319 522-4-2", "RFC 2045". */
const CODE = /^\p{Lu}[\p{Lu}/&.]*(?:\s\p{Lu}[\p{Lu}/&.]*)*\s?\d[\p{N}.\-:/ ]*$/u;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The issuing body is looked for at the start of the text only: the cover of the document. */
const CODE_TEXT = 20_000;

/**
 * The code of a document whose title starts with it ("EN 319 522-2 - V1.2.1 - Electronic …"
 * → "EN 319 522-2"). When the text writes an issuing body before the code ("ETSI EN 319
 * 522-2"), that form too; then the short forms of the code. Empty when the title has no code.
 * `text` is the body of the source page, for the compiler and the dream cycle alike.
 */
export function documentCodes(title: string, text: string): string[] {
  text = text.slice(0, CODE_TEXT);
  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length < 2) return [];
  const code = parts[0]!.trim();
  if (!CODE.test(code) || code.length > 40) return [];
  const out = [code];
  const body = escapeRe(code).replace(/\s+/g, "\\s+");
  const m = new RegExp(`(?<![\\p{L}\\p{N}])(${ISSUERS})\\s+${body}(?![\\p{L}\\p{N}]|-\\p{N})`, "u").exec(text);
  if (m && !code.startsWith(`${m[1]} `)) out.push(`${m[1]} ${code}`);
  out.push(...shortForms(code));
  return [...new Set(out)];
}
