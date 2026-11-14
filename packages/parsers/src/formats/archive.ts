import JSZip from "jszip";
import type { OcrProvider, Parser } from "../types.ts";

/**
 * ZIP archive: every file becomes a child source. Limits protect against zip bombs:
 * at most `MAX_ENTRIES` files and `MAX_TOTAL` bytes after decompression; a member whose
 * declared size is too large is skipped.
 */
const MAX_ENTRIES = 10_000;
const MAX_TOTAL = 2 * 1024 ** 3;
const MAX_MEMBER = 500 * 1024 ** 2;

export const zipParser: Parser = {
  id: "zip",
  version: "1",
  async parse(data, ctx) {
    const zip = await JSZip.loadAsync(data);
    const files = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(f.name));
    const warnings: string[] = [];
    if (files.length > MAX_ENTRIES) warnings.push(`too_many_entries:${files.length}`);
    const attachments = [];
    let total = 0;
    for (const f of files.slice(0, MAX_ENTRIES)) {
      const declared = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (declared > MAX_MEMBER || total + declared > MAX_TOTAL) {
        warnings.push(`skipped_large:${f.name}`);
        continue;
      }
      const buf = await f.async("nodebuffer");
      total += buf.length;
      if (total > MAX_TOTAL) {
        warnings.push("archive_limit_reached");
        break;
      }
      attachments.push({ name: f.name, data: buf });
    }
    return {
      markdown: `Archivio ZIP "${ctx.name}" con ${files.length} file:\n\n${files.slice(0, 500).map((f) => `- ${f.name}`).join("\n")}`,
      title: ctx.name,
      meta: { entries: files.length },
      attachments,
      warnings,
    };
  },
};

/**
 * Images: text by OCR when an OCR provider is configured; else the image is stored and
 * marked "ocr_unavailable" (searchable by name, compiled when OCR is available).
 */
export const imageParser: Parser = {
  id: "image",
  version: "1",
  async parse(data, ctx) {
    const ocr: OcrProvider | undefined = ctx.ocr;
    if (!ocr) {
      return { markdown: `Immagine "${ctx.name}" (${ctx.mime}, ${Math.round(data.length / 1024)} KB). Testo non estratto: OCR non configurato.`, title: ctx.name, lang: "simple", meta: { ocr: false }, attachments: [], warnings: ["ocr_unavailable"] };
    }
    const text = (await ocr.recognize(data, ctx.mime)).trim();
    return { markdown: text || `Immagine "${ctx.name}" senza testo riconoscibile.`, title: ctx.name, meta: { ocr: ocr.id }, attachments: [], warnings: text ? [] : ["no_text"] };
  },
};
