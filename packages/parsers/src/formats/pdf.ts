import { extractText, getDocumentProxy, getMeta } from "unpdf";
import type { Parser } from "../types.ts";
import { blocksToMarkdown, layoutBlocks, readPage, type PageLayout } from "./pdf-layout.ts";

/**
 * PDF to Markdown, one section per page ("## Pagina N"). The layout reader (`pdf-layout.ts`)
 * rebuilds headings, paragraphs, lists and tables from the positions of the text and the lines
 * drawn on the page; a table continued on the next page stays in the section where it starts.
 * Pages with almost no text are scans: their numbers go to `meta.scanPages`. A document that
 * is mostly scans is marked "needs_ocr"; the ingestion pipeline then renders those pages and
 * reads them with the OCR model, when one is configured.
 */
/** Characters under which a page is a scan (page numbers and headers only). */
const SCAN_CHARS = 40;

export const pdfParser: Parser = {
  id: "pdf",
  // 3: parts of pdf@2 sources had code blocks cut by the chunker; parsing again rebuilds them
  version: "3",
  async parse(data) {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const totalPages: number = pdf.numPages;
    let pages: string[];
    let chars: number[];
    const warnings: string[] = [];
    try {
      const layouts: PageLayout[] = [];
      for (let n = 1; n <= totalPages; n++) layouts.push(await readPage(pdf, n));
      chars = layouts.map((l) => l.chars);
      pages = layoutBlocks(layouts).map((b) => blocksToMarkdown(b).trim());
    } catch {
      // an unusual page structure: the plain text layer, as before
      const { text } = await extractText(pdf, { mergePages: false });
      pages = (text as string[]).map((t) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
      chars = pages.map((p) => p.length);
    }
    let info: Record<string, unknown> = {};
    try {
      info = ((await getMeta(pdf)).info ?? {}) as Record<string, unknown>;
    } catch {
      /* broken metadata does not stop the text */
    }
    const total = chars.reduce((n, c) => n + c, 0);
    const scanPages = chars.flatMap((c, i) => (c < SCAN_CHARS ? [i + 1] : []));
    // a few empty pages in a text PDF (covers, separators) are not worth a model call
    if (totalPages > 0 && (total / totalPages < SCAN_CHARS || scanPages.length / totalPages > 0.2)) warnings.push("needs_ocr");
    const markdown = pages.map((p, i) => (p ? `## Pagina ${i + 1}\n\n${p}` : "")).filter(Boolean).join("\n\n");
    const title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
    return {
      markdown,
      ...(title ? { title } : {}),
      meta: { pages: totalPages, ...(warnings.includes("needs_ocr") ? { scanPages } : {}), author: info.Author ?? undefined, producer: info.Producer ?? undefined, created: info.CreationDate ?? undefined },
      attachments: [],
      warnings,
    };
  },
};
