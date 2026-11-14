/**
 * Page images of a PDF for OCR (plan §4.3). Runs in a parser worker: rendering is CPU-bound.
 * PNG at `scale` × 72 dpi (2 = 144 dpi: enough for OCR models, small enough for one request).
 */
import { getDocumentProxy, renderPageAsImage } from "unpdf";

export async function renderPdfPages(data: Buffer, pages: number[], scale = 2): Promise<Buffer[]> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const out: Buffer[] = [];
  for (const n of pages) {
    const png = await renderPageAsImage(pdf, n, { canvasImport: () => import("@napi-rs/canvas"), scale });
    out.push(Buffer.from(png));
  }
  return out;
}
