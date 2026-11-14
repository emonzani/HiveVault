/**
 * Local document parsers (plan §4.3). Every parser turns a file into Markdown (L1) plus
 * metadata and the files it contains (email attachments, archive members, messages of a
 * mailbox), which the ingestion pipeline stores as child sources. Nothing leaves the server.
 */

export type Lang = "italian" | "english" | "simple";

export interface Attachment {
  name: string;
  data: Buffer;
  mime?: string;
}

export interface ParsedDocument {
  markdown: string;
  title?: string;
  lang: Lang;
  /** Format-specific facts: author, dates, sender, pages, sheets, message ids, ... */
  meta: Record<string, unknown>;
  attachments: Attachment[];
  /** Things a person should know: "needs_ocr", "truncated", "unsupported_part", ... */
  warnings: string[];
}

export interface ParseContext {
  name: string;
  mime: string;
  size: number;
  /** Upper bound of the Markdown kept (characters). */
  maxChars: number;
  ocr?: OcrProvider | undefined;
}

export interface Parser {
  id: string;
  /** Saved with each source: a newer version means the source is parsed again. */
  version: string;
  parse(data: Buffer, ctx: ParseContext): Promise<Omit<ParsedDocument, "lang"> & { lang?: Lang }>;
}

/** OCR is a provider so that the engine (tesseract, a local vision model) can change. */
export interface OcrProvider {
  id: string;
  recognize(image: Buffer, mime: string): Promise<string>;
}

export interface ParseResult extends ParsedDocument {
  parser: string;
  parserVersion: string;
  mime: string;
}
