/**
 * Test corpus by format (phase 3 acceptance: 20 files per format). Real files written with the
 * libraries that produce them in the wild (docx, exceljs, pptxgenjs, pdfkit); emails as
 * RFC 5322 with attachments; a ZIP that contains other formats. Each file carries a known
 * marker sentence, so a test can check that the parser extracted the text.
 *
 * Usage: npx tsx bench/corpus/formats.ts [--out data/corpus/formats] [--per 20]
 * Outlook .msg files are not generated (no JavaScript writer exists).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, HeadingLevel, TextRun } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import pptxgenModule from "pptxgenjs";
import { buildWorld, int, pick, rng, type Rng } from "./world.ts";

export interface FormatFile {
  file: string;
  format: string;
  /** A sentence that must appear in the extracted text. */
  marker: string;
  /** Expected child files (attachments, archive members, mailbox messages). */
  children: number;
}

// CommonJS default export: under ESM the class can be one level down
type PptxCtor = (typeof import("pptxgenjs"))["default"];
const pptxgen = ((pptxgenModule as unknown as { default?: PptxCtor }).default ?? (pptxgenModule as unknown as PptxCtor)) as PptxCtor;

function pdf(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", info: { Title: "Documento", Author: "Company example 1" } });
    const parts: Buffer[] = [];
    doc.on("data", (c: Buffer) => parts.push(c));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

// PDFKit's built-in fonts are WinAnsi: keep generated text in that range (Italian accents are fine)
const winAnsi = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff\n]/g, "-");

function eml(o: { from: string; to: string; subject: string; date: Date; id: string; body: string; replyTo?: string; attachments?: { name: string; mime: string; data: Buffer }[] }): string {
  const boundary = `b_${o.id.replace(/\W/g, "")}`;
  const head = [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date.toUTCString()}`,
    `Message-ID: <${o.id}>`,
    ...(o.replyTo ? [`In-Reply-To: <${o.replyTo}>`, `References: <${o.replyTo}>`] : []),
    "MIME-Version: 1.0",
  ];
  if (!o.attachments?.length) return [...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", o.body, ""].join("\r\n");
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    o.body,
    ...o.attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${a.name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.name}"`,
      "",
      a.data.toString("base64").replace(/.{76}/g, "$&\r\n"),
    ]),
    `--${boundary}--`,
    "",
  ];
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}

export async function generateFormats(out: string, per = 20, seed = 11): Promise<FormatFile[]> {
  const r: Rng = rng(seed);
  const w = buildWorld(r, { clients: 8, employees: 12, consultants: 3, projectsPerClient: 1 });
  const files: FormatFile[] = [];
  const put = async (format: string, name: string, data: Buffer | string, marker: string, children = 0) => {
    const file = path.join(format, name);
    await mkdir(path.join(out, format), { recursive: true });
    await writeFile(path.join(out, file), data);
    files.push({ file: file.replaceAll("\\", "/"), format, marker, children });
  };
  const person = () => pick(r, w.employees);

  for (let i = 0; i < per; i++) {
    const c = w.clients[i % w.clients.length]!;
    const p = w.projects[i % w.projects.length]!;
    const tag = `${c.name.split(" ")[0]}-${i}`;
    const marker = `Il contratto ${tag} prevede ${c.seats + i} postazioni di ${c.product}.`;

    // Markdown and text
    await put("md", `nota-${i}.md`, `---\ntitle: Nota ${tag}\n---\n# Nota ${tag}\n\n${marker}\n\n- Referente: ${w.people.get(c.techContact)!.name}\n`, marker);
    await put("txt", `appunti-${i}.txt`, `Appunti riunione ${tag}\n\n${marker}\nProssimi passi: verifica con ${person().name}.\n`, marker);

    // CSV (semicolon, Italian decimals) — every fourth file is large and gets summarized
    const rows = i % 4 === 0 ? 1500 : 30;
    const csv = ["data;cliente;prodotto;postazioni;importo_eur", ...Array.from({ length: rows }, (_, k) => `2026-0${(k % 9) + 1}-1${k % 9};${c.name};${c.product};${c.seats + k};${(c.seats * c.pricePerSeat + k).toFixed(2).replace(".", ",")}`)].join("\n");
    await put("csv", `ordini-${i}.csv`, csv, rows > 200 ? "righe" : c.name);

    // DOCX with heading, paragraphs and a table
    const docx = new Document({
      creator: person().name,
      title: `Analisi tecnica ${tag}`,
      sections: [
        {
          children: [
            new Paragraph({ text: `Analisi tecnica ${tag}`, heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ children: [new TextRun(marker)] }),
            new Paragraph({ text: "Architettura", heading: HeadingLevel.HEADING_2 }),
            new Paragraph(`Backend ${p.stack}, database ${p.database.name} per ${p.database.why}.`),
            new Table({
              rows: [
                new TableRow({ children: [new TableCell({ children: [new Paragraph("Componente")] }), new TableCell({ children: [new Paragraph("Tecnologia")] })] }),
                new TableRow({ children: [new TableCell({ children: [new Paragraph("Database")] }), new TableCell({ children: [new Paragraph(p.database.name)] })] }),
              ],
            }),
          ],
        },
      ],
    });
    await put("docx", `analisi-${i}.docx`, await Packer.toBuffer(docx), marker);

    // XLSX with two sheets and a formula
    const wb = new ExcelJS.Workbook();
    wb.creator = person().name;
    const ws = wb.addWorksheet("Ordini");
    ws.addRow(["Cliente", "Postazioni", "Canone", "Totale"]);
    for (let k = 0; k < 10; k++) {
      const row = ws.addRow([c.name, c.seats + k, c.pricePerSeat, null]);
      row.getCell(4).value = { formula: `B${row.number}*C${row.number}`, result: (c.seats + k) * c.pricePerSeat };
    }
    wb.addWorksheet("Note").addRows([["Nota"], [marker]]);
    await put("xlsx", `listino-${i}.xlsx`, Buffer.from(await wb.xlsx.writeBuffer()), marker);

    // PPTX: title slide, content slide with notes
    const deck = new pptxgen();
    deck.title = `Stato progetto ${tag}`;
    const s1 = deck.addSlide();
    s1.addText(`Stato ${p.name}`, { placeholder: "title", x: 0.5, y: 0.5, w: 9, h: 1 });
    const s2 = deck.addSlide();
    s2.addText([{ text: marker }, { text: `Consegna prevista: ${p.deadline}` }], { x: 0.5, y: 1, w: 9, h: 3 });
    s2.addNotes(`Ricordare a ${w.people.get(c.salesContact)!.name} il rinnovo.`);
    await put("pptx", `stato-${i}.pptx`, (await deck.write({ outputType: "nodebuffer" })) as Buffer, marker);

    // PDF: two pages
    const pdfBuf = await pdf((doc) => {
      doc.fontSize(18).text(winAnsi(`Verbale ${tag}`));
      doc.moveDown().fontSize(11).text(winAnsi(marker));
      doc.addPage().text(winAnsi(`Seconda pagina: azioni per ${person().name}.`));
    });
    await put("pdf", `verbale-${i}.pdf`, pdfBuf, marker.replace(/[^\x20-\x7e\xa0-\xff]/g, "-"));

    // EML with an attachment (the CSV) and a quoted reply that must be removed
    const from = w.people.get(c.salesContact)!;
    const to = person();
    await put(
      "eml",
      `messaggio-${i}.eml`,
      eml({
        from: `${from.name} <${from.email}>`,
        to: `${to.name} <${to.email}>`,
        subject: `Re: rinnovo ${tag}`,
        date: new Date(Date.UTC(2026, 1, 1 + i)),
        id: `m${i}.${seed}@example.com`,
        replyTo: `m${i}.0@example.com`,
        body: `Buongiorno,\n\n${marker}\n\nCordiali saluti\n-- \n${from.name}\n\nIl 01/02/2026 ${to.name} ha scritto:\n> Testo citato che non deve essere indicizzato ${tag}.`,
        attachments: [{ name: `ordini-${i}.csv`, mime: "text/csv", data: Buffer.from(csv.split("\n").slice(0, 5).join("\n")) }],
      }),
      marker,
      1,
    );

    // HTML page
    await put(
      "html",
      `pagina-${i}.html`,
      `<!doctype html><html><head><title>Notizia ${tag}</title><script>var x=1</script></head><body><nav>menu home contatti</nav><article><h1>Notizia ${tag}</h1><p>${marker}</p><p>${"Testo dell'articolo con dettagli sul progetto. ".repeat(12)}</p></article><footer>copyright</footer></body></html>`,
      marker,
    );

    // Source code
    await put("code", `servizio-${i}.ts`, `// ${marker}\nexport interface Ordine { cliente: string; postazioni: number }\n\nexport function totale(o: Ordine, canone: number): number {\n  return o.postazioni * canone;\n}\n`, "totale");

    // ZIP containing a text file and a CSV
    const zip = new JSZip();
    zip.file(`dentro/nota-${i}.txt`, `Nota nell'archivio. ${marker}`);
    zip.file(`dentro/dati-${i}.csv`, "a;b\n1;2\n");
    zip.file("__MACOSX/._nota.txt", "junk");
    await put("zip", `archivio-${i}.zip`, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), `nota-${i}.txt`, 2);

    // Image: a tiny valid PNG (no OCR text expected)
    await put("image", `scansione-${i}.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), "Immagine");
  }

  // Mailboxes: 20 per format makes 20 × n messages; one mbox per 5 messages
  for (let i = 0; i < per; i++) {
    const msgs = Array.from({ length: 5 }, (_, k) => {
      const a = person();
      const b = person();
      return `From ${a.email} Mon Feb  ${String((k % 9) + 1).padStart(2, " ")} 10:00:00 2026\r\n` + eml({ from: `${a.name} <${a.email}>`, to: `${b.name} <${b.email}>`, subject: `Aggiornamento ${i}-${k}`, date: new Date(Date.UTC(2026, 1, k + 1)), id: `mb${i}.${k}@example.com`, body: `Messaggio ${k} della casella ${i}.\nFrom the beginning: this line starts with From.` }).replace(/^From /gm, ">From ").replace(/^>From (\S+@\S+ Mon)/, "From $1");
    });
    await put("mbox", `casella-${i}.mbox`, msgs.join("\r\n"), "Archivio di posta con 5 messaggi", 5);
  }
  void int;
  return files;
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (n: string, d: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1]! : d;
  };
  const out = path.resolve(opt("out", "data/corpus/formats"));
  const files = await generateFormats(out, Number(opt("per", "20")));
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(files, null, 2));
  const by = files.reduce<Record<string, number>>((m, f) => ((m[f.format] = (m[f.format] ?? 0) + 1), m), {});
  console.log(`${files.length} file in ${out}`, by);
}
