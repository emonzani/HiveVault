import JSZip from "jszip";
import mammoth from "mammoth";
import TurndownService from "turndown";
import type { Parser } from "../types.ts";
import { xmlText } from "../util.ts";

export const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
// Tables: turndown has no GFM tables by default; a simple row-by-row rule keeps their text.
turndown.addRule("table", {
  filter: ["table"],
  replacement: (_c, node) => {
    type El = { querySelectorAll(s: string): ArrayLike<El>; textContent: string | null };
    const rows = Array.from((node as unknown as El).querySelectorAll("tr")).map((tr) =>
      Array.from(tr.querySelectorAll("th,td")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()),
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return "\n\n" + [line(rows[0]!), `|${Array(width).fill("---").join("|")}|`, ...rows.slice(1).map(line)].join("\n") + "\n\n";
  },
});

async function coreProps(zip: JSZip): Promise<{ title?: string; author?: string; created?: string; modified?: string }> {
  const xml = await zip.file("docProps/core.xml")?.async("string");
  if (!xml) return {};
  const tag = (t: string) => {
    const m = new RegExp(`<${t}[^>]*>([^<]*)</${t}>`).exec(xml);
    return m?.[1] ? xmlText(m[1]).trim() || undefined : undefined;
  };
  const out: { title?: string; author?: string; created?: string; modified?: string } = {};
  const title = tag("dc:title");
  const author = tag("dc:creator");
  const created = tag("dcterms:created");
  const modified = tag("dcterms:modified");
  if (title) out.title = title;
  if (author) out.author = author;
  if (created) out.created = created;
  if (modified) out.modified = modified;
  return out;
}

export const docxParser: Parser = {
  id: "docx",
  version: "1",
  async parse(data) {
    const { value: html, messages } = await mammoth.convertToHtml({ buffer: data });
    const zip = await JSZip.loadAsync(data);
    const props = await coreProps(zip);
    const markdown = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
    const { title, ...meta } = props;
    const warnings = messages.filter((m) => m.type === "warning").length ? ["docx_conversion_warnings"] : [];
    return { markdown, ...(title ? { title } : {}), meta, attachments: [], warnings };
  },
};

/** PowerPoint: one section per slide (title, text, speaker notes). */
export const pptxParser: Parser = {
  id: "pptx",
  version: "1",
  async parse(data) {
    const zip = await JSZip.loadAsync(data);
    const slideFiles = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    const paragraphs = (xml: string) =>
      [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
        .map((p) => [...p[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => xmlText(t[1]!)).join(""))
        .map((s) => s.trim())
        .filter(Boolean);
    const sections: string[] = [];
    for (const [i, f] of slideFiles.entries()) {
      const xml = await zip.file(f)!.async("string");
      // the title placeholder, if any
      const titleShape = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/.exec(xml)?.[0];
      let title = titleShape ? paragraphs(titleShape).join(" ") : "";
      let body = paragraphs(titleShape ? xml.replace(titleShape, "") : xml);
      // Decks made by generators often have no title placeholder: a short first line is the title
      if (!title && body.length > 0 && body[0]!.length <= 80 && (body.length > 1 || i === 0)) {
        title = body[0]!;
        body = body.slice(1);
      }
      const n = /(\d+)\.xml$/.exec(f)![1];
      const notesXml = await zip.file(`ppt/notesSlides/notesSlide${n}.xml`)?.async("string");
      const notes = notesXml ? paragraphs(notesXml).filter((t) => !/^\d+$/.test(t)) : [];
      sections.push(
        [`## Slide ${i + 1}${title ? ` — ${title}` : ""}`, body.map((b) => `- ${b}`).join("\n"), notes.length ? `> Note del relatore: ${notes.join(" ")}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    const props = await coreProps(zip);
    const { title, ...meta } = props;
    return { markdown: sections.join("\n\n"), ...(title ? { title } : {}), meta: { ...meta, slides: slideFiles.length }, attachments: [], warnings: [] };
  },
};
