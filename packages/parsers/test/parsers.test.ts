import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFormats, type FormatFile } from "../../../bench/corpus/formats.ts";
import { elementText } from "../src/formats/office.ts";
import { detectType, parseFile, ParserPool, stripQuotes, UnsupportedFormatError } from "../src/index.ts";

let dir = "";
let files: FormatFile[] = [];
const flat = (s: string) => s.replace(/\s+/g, " ");
/** A PPTX with these slide XML bodies and, where given, speaker notes. */
const pptx = async (slides: [string, string?][]) => {
  const zip = new JSZip();
  slides.forEach(([slide, notes], i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:cSld><p:spTree>${slide}</p:spTree></p:cSld></p:sld>`);
    if (notes !== undefined) zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, notes);
  });
  zip.file("[Content_Types].xml", "<Types/>");
  return zip.generateAsync({ type: "nodebuffer" });
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cb-formats-"));
  files = await generateFormats(dir, 20);
}, 120_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("parse every file of the format corpus (20 per format)", () => {
  it("extracts the marker text and the expected children from all 260 files", async () => {
    const failures: string[] = [];
    const byFormat = new Map<string, number>();
    for (const f of files) {
      try {
        const r = await parseFile(await readFile(path.join(dir, f.file)), path.basename(f.file));
        if (!flat(r.markdown).includes(flat(f.marker))) failures.push(`${f.file}: marker missing`);
        if (r.attachments.length !== f.children) failures.push(`${f.file}: ${r.attachments.length} children, expected ${f.children}`);
        byFormat.set(f.format, (byFormat.get(f.format) ?? 0) + 1);
      } catch (e) {
        failures.push(`${f.file}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect([...byFormat.values()].every((n) => n === 20)).toBe(true);
    expect(byFormat.size).toBe(13);
  }, 120_000);
});

describe("format details", () => {
  const parse = async (file: string) => parseFile(await readFile(path.join(dir, file)), path.basename(file));

  it("email: Italian header, no quoted history, no signature, thread ids, attachment", async () => {
    const r = await parse("eml/messaggio-3.eml");
    expect(r.markdown).toMatch(/^\*\*Da:\*\* .+\n\*\*A:\*\* .+/);
    expect(r.markdown).toContain("**Oggetto:** Re: rinnovo");
    expect(r.markdown).not.toContain("Testo citato");
    expect(r.markdown).not.toContain("Cordiali saluti\n--");
    expect(r.meta).toMatchObject({ messageId: "<m3.11@example.com>", inReplyTo: "<m3.0@example.com>" });
    expect(r.attachments[0]).toMatchObject({ name: "ordini-3.csv" });
    expect(r.title).toBe("Re: rinnovo " + r.title!.split("rinnovo ")[1]);
  });

  it("mailbox: one child per message, mboxrd '>From' unescaped", async () => {
    const r = await parse("mbox/casella-2.mbox");
    expect(r.attachments).toHaveLength(5);
    const first = await parseFile(r.attachments[0]!.data, r.attachments[0]!.name);
    expect(first.markdown).toContain("From the beginning: this line starts with From.");
    expect(first.meta).toMatchObject({ messageId: "<mb2.0@example.com>" });
  });

  it("pptx: one section per slide with title and speaker notes", async () => {
    const r = await parse("pptx/stato-1.pptx");
    expect(r.markdown).toMatch(/## Slide 1 — Stato Progetto/);
    expect(r.markdown).toMatch(/## Slide 2/);
    expect(r.markdown).toMatch(/> Note del relatore: Ricordare a .+ il rinnovo\./);
    expect(r.meta).toMatchObject({ slides: 2 });
  });

  it("pptx: a real title placeholder wins over the first line", async () => {
    const zip = new JSZip();
    const sp = (ph: string, text: string) => `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    zip.file("ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree>${sp("", "Testo prima")}${sp('<p:ph type="title"/>', "Titolo vero &amp; unico")}</p:spTree></p:cSld></p:sld>`);
    zip.file("[Content_Types].xml", "<Types/>");
    const r = await parseFile(await zip.generateAsync({ type: "nodebuffer" }), "deck.pptx");
    expect(r.markdown).toMatch(/^## Slide 1 — Titolo vero & unico\n\n- Testo prima/);
  });

  it("pptx: titles, text and notes of well-formed and malformed slides stay as before", async () => {
    const p = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
    const sp = (ph: string, body: string) => `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
    const deck = await pptx([
      [sp('<p:ph type="ctrTitle"/>', p("Piano &amp; budget")) + sp('<p:ph type="subTitle" idx="1"/>', p("Sottotitolo")), `<p:notes>${p("1")}${p(" Ricordare &lt;la&gt; data ")}</p:notes>`],
      // an unclosed shape before the title shape: the title runs from the unclosed <p:sp>
      ["<p:sp>" + p("Orfano") + sp('<p:ph type="title"/>', p("Titolo")) + sp("", p("Corpo"))],
      [sp("", p("Primo")) + sp('<p:ph type="title"/>', p("Secondo")) + sp('<p:ph type="body"/>', p("Terzo"))],
      [p("Uno") + p("Due") + "<a:p><a:r><a:t>Perso</a:t>"],
      // nested <a:p>; a title placeholder in a shape that never closes
      ["<a:p><a:t>A</a:t><a:p><a:t>B</a:t></a:p></a:p>" + p("C") + '<p:sp><p:ph type="title"/>' + p("Senza chiusura")],
      // the title shape removed from inside a paragraph
      ["<a:p><a:t>Prima</a:t>" + sp('<p:ph type="title"/>', p("T")) + "</a:p>" + p("Dopo")],
      ['<p:ph type="title"/></p:sp>' + sp("", p("Fuori")) + "<p:sp><p:ph type='title'/>" + p("Apici") + "</p:sp>", "<p:notes><a:p><a:t>nota senza chiusura</a:t></p:notes>"],
      [sp('<p:ph type="title"/>', "<a:p></a:p><a:p><a:t> </a:t></a:p>") + p("Corpo &#233;")],
    ]);
    const r = await parseFile(deck, "deck.pptx");
    expect(r.markdown).toBe(
      "## Slide 1 — Piano & budget\n\n- Sottotitolo\n\n> Note del relatore: Ricordare <la> data\n\n## Slide 2 — Orfano Titolo\n\n- Corpo\n\n" +
        "## Slide 3 — Secondo\n\n- Primo\n- Terzo\n\n## Slide 4 — Uno\n\n- Due\n\n## Slide 5 — AB\n\n- C\n- Senza chiusura\n\n" +
        "## Slide 6 — T\n\n- Prima\n- Dopo\n\n## Slide 7 — Fuori\n\n- Apici\n\n## Slide 8\n\n- Corpo é",
    );
    expect(r.meta).toMatchObject({ slides: 8 });
  });

  it("xlsx: one section per sheet, formulas as their values", async () => {
    const r = await parse("xlsx/listino-0.xlsx");
    expect(r.markdown).toMatch(/## Foglio: Ordini/);
    expect(r.markdown).toMatch(/## Foglio: Note/);
    const firstRow = /\| (.+?) \| (\d+) \| (\d+) \| (\d+) \|/.exec(r.markdown)!;
    expect(Number(firstRow[4])).toBe(Number(firstRow[2]) * Number(firstRow[3]));
  });

  it("csv: small tables in full, large tables summarized with column statistics", async () => {
    const small = await parse("csv/ordini-1.csv");
    expect(small.meta).toMatchObject({ rows: 30, columns: 5, delimiter: ";" });
    const big = await parse("csv/ordini-0.csv");
    expect(big.meta).toMatchObject({ rows: 1500, summarized: true });
    expect(big.markdown).toMatch(/\| postazioni \| numero \| 1500 \|/);
  });

  it("pdf: one section per page, metadata", async () => {
    const r = await parse("pdf/verbale-0.pdf");
    expect(r.markdown).toMatch(/## Pagina 1[\s\S]*## Pagina 2/);
    expect(r.meta).toMatchObject({ pages: 2 });
    expect(r.warnings).not.toContain("needs_ocr");
  });

  it("html: the article only, no script, navigation or footer", async () => {
    const r = await parse("html/pagina-0.html");
    expect(r.title).toMatch(/^Notizia /);
    expect(r.markdown).not.toMatch(/var x|menu home|copyright/);
  });

  it("docx: headings, table and author", async () => {
    const r = await parse("docx/analisi-0.docx");
    expect(r.markdown).toMatch(/^# Analisi tecnica/m);
    expect(r.markdown).toMatch(/## Architettura/);
    expect(r.markdown).toMatch(/\| Database \| /);
    expect(r.meta.author).toBeTruthy();
  });

  it("code: kept verbatim in a fenced block, language detected, not stemmed", async () => {
    const r = await parse("code/servizio-0.ts");
    expect(r.markdown.startsWith("```typescript")).toBe(true);
    expect(r.lang).toBe("simple");
    expect(r.meta).toMatchObject({ language: "typescript" });
  });

  it("zip: members become children, OS junk is skipped", async () => {
    const r = await parse("zip/archivio-0.zip");
    expect(r.attachments.map((a) => a.name).sort()).toEqual(["dentro/dati-0.csv", "dentro/nota-0.txt"]);
  });

  it("image without OCR: stored and flagged", async () => {
    const r = await parse("image/scansione-0.png");
    expect(r.warnings).toContain("ocr_unavailable");
  });

  it("language: Italian and English text get their stemmer", async () => {
    expect((await parseFile(Buffer.from("Il cliente ha confermato che la consegna della fornitura è prevista per la fine del mese."), "a.txt")).lang).toBe("italian");
    expect((await parseFile(Buffer.from("The customer confirmed that the delivery of the order is planned for the end of the month."), "a.txt")).lang).toBe("english");
  });
});

describe("office core properties (docProps/core.xml)", () => {
  const TAGS = ["dc:title", "dc:creator", "dcterms:created", "dcterms:modified"];
  // The regex the parser used before; it is quadratic, so only short inputs here.
  const reference = (xml: string, t: string) => new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(xml)?.[1];
  const deck = async (core: string | undefined) => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>");
    zip.file("[Content_Types].xml", "<Types/>");
    if (core !== undefined) zip.file("docProps/core.xml", core);
    const r = await parseFile(await zip.generateAsync({ type: "nodebuffer" }), "deck.pptx");
    return { title: r.title, meta: r.meta };
  };
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;

  it("keeps the metadata of well-formed and malformed core.xml", async () => {
    const cases: [string | undefined, { title?: string; meta: Record<string, unknown> }][] = [
      [
        head +
          `<dc:title>Analisi &amp; &lt;piano&gt;</dc:title><dc:creator> Mario Rossi </dc:creator>` +
          `<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created>` +
          `<dcterms:modified xsi:type="dcterms:W3CDTF">2026-02-03T04:05:06Z</dcterms:modified></cp:coreProperties>`,
        { title: "Analisi & <piano>", meta: { author: "Mario Rossi", created: "2026-01-02T03:04:05Z", modified: "2026-02-03T04:05:06Z", slides: 1 } },
      ],
      [undefined, { meta: { slides: 1 } }],
      ["", { meta: { slides: 1 } }],
      [`<dc:title></dc:title><dc:creator>  </dc:creator><dc:title/>`, { meta: { slides: 1 } }],
      [`<dc:title><dc:title>Secondo</dc:title><dc:title>Terzo</dc:title>`, { title: "Secondo", meta: { slides: 1 } }],
      [`<dc:titleX>Prefisso</dc:title><dc:creator a="<b">Autore</dc:creator>`, { title: "Prefisso", meta: { author: "Autore", slides: 1 } }],
      [`<dc:title>Aperto<dcterms:created>2026</dcterms:created>`, { meta: { created: "2026", slides: 1 } }],
      [`<dc:creator/><dc:creator>Dopo</dc:creator><dcterms:modified>&#65;&amp;lt;</dcterms:modified>`, { meta: { author: "Dopo", modified: "A&lt;", slides: 1 } }],
      [`<dc:title`, { meta: { slides: 1 } }],
      [`<dc:title>coda`, { meta: { slides: 1 } }],
    ];
    for (const [core, expected] of cases) expect(await deck(core), String(core)).toEqual(expected);
  });

  it("finds the same element text as the old regex (all strings of up to 5 tokens)", () => {
    const tokens = ["<dc:title", ">", "<", "</dc:title>", "</dc:title", "x", "/", "<dc:titl", "e"];
    let strings = 0;
    const mismatches: string[] = [];
    const walk = (s: string, depth: number) => {
      strings++;
      for (const t of TAGS) if (elementText(s, t) !== reference(s, t)) mismatches.push(`${t}: ${JSON.stringify(s)}`);
      if (depth > 0) for (const tok of tokens) walk(s + tok, depth - 1);
    };
    walk("", 5);
    expect(mismatches).toEqual([]);
    expect(strings).toBe(66_430);
  });

  it("parses a hostile core.xml in linear time", async () => {
    // Thousands of "<dc:title" before one far ">": the old regex rescanned to it from each one.
    const hostile = "<dc:title".repeat(400_000) + "><x/><dc:title>Titolo</dc:title>";
    const started = performance.now();
    expect(elementText(hostile, "dc:title")).toBe("Titolo");
    for (const t of TAGS) expect(elementText(`<${t}`.repeat(400_000) + "><b>", t)).toBeUndefined();
    expect(await deck(hostile)).toEqual({ title: "Titolo", meta: { slides: 1 } });
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("detection and safety", () => {
  it("detects the format from the content, not the name", async () => {
    const pdf = await readFile(path.join(dir, "pdf/verbale-0.pdf"));
    expect((await detectType(pdf, "fattura.txt")).kind).toBe("pdf");
    expect((await detectType(Buffer.from("From: a@b.it\nTo: c@d.it\nSubject: x\nMessage-ID: <1@b>\n\nciao"), "senza-estensione")).kind).toBe("eml");
  });

  it("reads Windows-1252 text and refuses unknown binaries", async () => {
    const latin = Buffer.from([0x43, 0x69, 0x74, 0x74, 0xe0, 0x20, 0x80]); // "Città €" in Windows-1252
    expect((await parseFile(latin, "a.txt")).markdown).toBe("Città €");
    await expect(parseFile(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]), "x.bin")).rejects.toBeInstanceOf(UnsupportedFormatError);
  });

  it("truncates huge text with a warning", async () => {
    const r = await parseFile(Buffer.from("parola ".repeat(10_000)), "a.txt", { maxChars: 1000 });
    expect(r.markdown.length).toBeLessThan(1200);
    expect(r.warnings).toContain("truncated");
  });

  it("limits ZIP members (zip bomb protection) and skips nothing below the limits", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 3; i++) zip.file(`f${i}.txt`, "x");
    const r = await parseFile(await zip.generateAsync({ type: "nodebuffer" }), "a.zip");
    expect(r.attachments).toHaveLength(3);
  });

  it("pptx: unclosed shapes and paragraphs take linear time", async () => {
    // The old regexes rescanned to the end of the slide from every opener: about 40 s here.
    // Slide 3 checks that the title placeholder search does not rescan for each shape.
    const n = 100_000;
    const deck = await pptx([
      ["<p:sp>".repeat(n)],
      ["<p:sp>".repeat(n) + "</p:sp>"],
      ["<p:sp></p:sp>".repeat(n) + '<p:ph type="title"/>'],
      ["<a:p>".repeat(n), "<a:p>".repeat(n)],
    ]);
    const start = performance.now();
    const r = await parseFile(deck, "deck.pptx");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(r.markdown).toBe("## Slide 1\n\n## Slide 2\n\n## Slide 3\n\n## Slide 4");
  });

  it("removes quoted replies in Italian and English", () => {
    expect(stripQuotes("Va bene.\n\nIl giorno 3 marzo 2026, Nome CognomeDDD ha scritto:\n> testo vecchio")).toBe("Va bene.");
    expect(stripQuotes("OK\n\nOn Tue, 3 Mar 2026 John wrote:\n> old")).toBe("OK");
    expect(stripQuotes("Sì.\n\n-----Messaggio originale-----\nDa: x")).toBe("Sì.");
  });
});

describe("ParserPool", () => {
  it("parses in worker threads, many files at once", async () => {
    const pool = new ParserPool({ threads: 3 });
    try {
      const pick = files.filter((f) => ["pdf", "docx", "xlsx", "pptx"].includes(f.format)).slice(0, 24);
      const results = await Promise.all(pick.map(async (f) => pool.parse(await readFile(path.join(dir, f.file)), path.basename(f.file))));
      results.forEach((r, i) => expect(flat(r.markdown)).toContain(flat(pick[i]!.marker)));
      expect(pool.stats.completed).toBeGreaterThanOrEqual(24);
    } finally {
      await pool.close();
    }
  }, 120_000);

  it("renders PDF pages as PNG images in a worker (OCR of scans)", async () => {
    const pool = new ParserPool({ threads: 1 });
    try {
      const pngs = await pool.render(await readFile(path.join(dir, "pdf/verbale-0.pdf")), [2, 1], 1);
      expect(pngs).toHaveLength(2);
      for (const p of pngs) expect(p.subarray(1, 4).toString("latin1")).toBe("PNG");
    } finally {
      await pool.close();
    }
  }, 60_000);
});
