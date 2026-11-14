import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { parseFile } from "../src/index.ts";

/** A PDF made with pdfkit: draw(doc) writes the pages. */
function makePdf(draw: (doc: PDFKit.PDFDocument) => void, opts: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, ...opts });
    const parts: Buffer[] = [];
    doc.on("data", (b: Buffer) => parts.push(b));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    draw(doc);
    doc.end();
  });
}

/** A ruled table: one header row and the given rows, columns of fixed width. */
function table(doc: PDFKit.PDFDocument, top: number, header: string[], rows: string[][]) {
  const widths = [80, 200, 160];
  const x0 = 60;
  const rowH = 22;
  const all = [header, ...rows];
  all.forEach((r, i) => {
    let x = x0;
    r.forEach((cell, c) => {
      doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(10).text(cell, x + 4, top + i * rowH + 6, { lineBreak: false });
      x += widths[c]!;
    });
  });
  const right = x0 + widths.reduce((a, b) => a + b, 0);
  const bottom = top + all.length * rowH;
  for (let i = 0; i <= all.length; i++) doc.moveTo(x0, top + i * rowH).lineTo(right, top + i * rowH).lineWidth(0.5).stroke();
  let x = x0;
  for (const w of [0, ...widths]) {
    x += w;
    doc.moveTo(x, top).lineTo(x, bottom).lineWidth(0.5).stroke();
  }
}

const footer = (doc: PDFKit.PDFDocument, n: number) => {
  doc.font("Helvetica").fontSize(8).text("Documento di prova - riservato", 50, 790, { lineBreak: false });
  doc.text(`Pagina ${n} di 3`, 480, 790, { lineBreak: false });
};

describe("pdf layout", () => {
  it("rebuilds headings, paragraphs and one table across a page break", async () => {
    const header = ["Codice", "Descrizione", "Valore"];
    const data = await makePdf((doc) => {
      doc.font("Helvetica-Bold").fontSize(16).text("1 Requisiti del servizio", 50, 60);
      doc.font("Helvetica").fontSize(10).text("Il fornitore garantisce la disponibilita del servizio nelle ore lavorative. ".repeat(4), 50, 100, { width: 480 });
      doc.font("Helvetica-Bold").text("Tabella 1", 50, 180, { lineBreak: false });
      table(doc, 200, header, Array.from({ length: 6 }, (_, i) => [`R${i}`, `Riga numero ${i}`, `${i * 10}`]));
      footer(doc, 1);
      doc.addPage();
      table(doc, 60, header, Array.from({ length: 4 }, (_, i) => [`R${i + 6}`, `Riga numero ${i + 6}`, `${(i + 6) * 10}`]));
      doc.font("Helvetica-Bold").fontSize(13).text("1.1 Penali", 50, 200);
      doc.font("Helvetica").fontSize(10).text("Le penali si applicano dopo il terzo giorno di ritardo.", 50, 230);
      footer(doc, 2);
      doc.addPage();
      doc.font("Helvetica").fontSize(10).text("Fine del documento.", 50, 60);
      footer(doc, 3);
    });
    const r = await parseFile(data, "contratto.pdf");
    const md = r.markdown;
    expect(md).toMatch(/^### 1 Requisiti del servizio$/m);
    expect(md).toMatch(/^#### 1\.1 Penali$/m);
    expect(md).toMatch(/^Il fornitore garantisce .* lavorative\.$/m);
    expect(md).toContain("**Tabella 1**");
    // one table with a single header, rows of both pages in order
    expect(md.match(/^\| Codice \| Descrizione \| Valore \|$/gm)).toHaveLength(1);
    const rows = [...md.matchAll(/^\| (R\d+) \| Riga numero \d+ \| \d+ \|$/gm)].map((m) => m[1]);
    expect(rows).toEqual(Array.from({ length: 10 }, (_, i) => `R${i}`));
    // the table stays in the section of the page where it starts
    expect(md.indexOf("| R9 |")).toBeLessThan(md.indexOf("## Pagina 2"));
    // running footer removed
    expect(md).not.toMatch(/riservato|di 3/);
    expect(r.warnings).not.toContain("needs_ocr");
  });

  it("keeps the layout of monospaced code and joins wrapped prose", async () => {
    const data = await makePdf((doc) => {
      doc.font("Courier").fontSize(10);
      const lines = [
        "1.  Introduction",
        "",
        "   A time-stamping service supports assertions of proof that a datum",
        "   existed before a particular time.",
        "",
        "   TimeStampReq ::= SEQUENCE  {",
        "      version          INTEGER  { v1(1) },",
        "      nonce            INTEGER  OPTIONAL }",
      ];
      lines.forEach((l, i) => doc.text(l, 50, 60 + i * 12, { lineBreak: false }));
    });
    const r = await parseFile(data, "rfc.pdf");
    expect(r.markdown).toMatch(/^### 1\. Introduction$/m);
    expect(r.markdown).toContain("A time-stamping service supports assertions of proof that a datum existed before a particular time.");
    expect(r.markdown).toContain("```\nTimeStampReq ::= SEQUENCE  {\n   version          INTEGER  { v1(1) },\n   nonce            INTEGER  OPTIONAL }\n```");
  });
});
