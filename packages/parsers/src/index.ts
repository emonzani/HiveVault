import { detectType, type Detected } from "./detect.ts";
import { imageParser, zipParser } from "./formats/archive.ts";
import { emlParser, mboxParser, msgParser } from "./formats/mail.ts";
import { docxParser, pptxParser } from "./formats/office.ts";
import { pdfParser } from "./formats/pdf.ts";
import { csvParser, xlsxParser } from "./formats/tabular.ts";
import { codeParser, textParser } from "./formats/text.ts";
import { htmlParser } from "./formats/web.ts";
import type { OcrProvider, Parser, ParseResult } from "./types.ts";
import { detectLang, truncate } from "./util.ts";

export * from "./types.ts";
export { detectType, type Detected } from "./detect.ts";
export { stripQuotes } from "./formats/mail.ts";
export { describeTable, detectLang } from "./util.ts";
export { ParserPool } from "./pool.ts";
export { renderPdfPages } from "./render.ts";

const BY_KIND: Record<Detected["kind"], Parser | undefined> = {
  pdf: pdfParser,
  docx: docxParser,
  xlsx: xlsxParser,
  pptx: pptxParser,
  eml: emlParser,
  msg: msgParser,
  mbox: mboxParser,
  html: htmlParser,
  csv: csvParser,
  markdown: textParser,
  text: textParser,
  code: codeParser,
  zip: zipParser,
  image: imageParser,
  unknown: undefined,
};

/** Every parser with its version: stored per source, compared by the dream cycle. */
export const PARSER_VERSIONS: Record<string, string> = Object.fromEntries(
  Object.values(BY_KIND)
    .filter((p): p is Parser => !!p)
    .map((p) => [p.id, p.version]),
);

export class UnsupportedFormatError extends Error {
  constructor(readonly mime: string) {
    super(`Formato non supportato (${mime}).`);
    this.name = "UnsupportedFormatError";
  }
}

export interface ParseOptions {
  /** Upper bound of extracted Markdown (characters). Default 20 million (~5M tokens). */
  maxChars?: number;
  ocr?: OcrProvider;
}

/** Detects the format and parses in the current thread. The pool runs this in workers. */
export async function parseFile(data: Buffer, name: string, o: ParseOptions = {}): Promise<ParseResult> {
  const d = await detectType(data, name);
  const parser = BY_KIND[d.kind];
  if (!parser) throw new UnsupportedFormatError(d.mime);
  const maxChars = o.maxChars ?? 20_000_000;
  const r = await parser.parse(data, { name, mime: d.mime, size: data.length, maxChars, ocr: o.ocr });
  const warnings = [...r.warnings];
  const markdown = truncate(r.markdown.replace(/\u0000/g, ""), maxChars, warnings);
  return {
    ...r,
    markdown,
    lang: r.lang ?? detectLang(markdown),
    warnings,
    parser: parser.id,
    parserVersion: parser.version,
    mime: d.mime,
  };
}
