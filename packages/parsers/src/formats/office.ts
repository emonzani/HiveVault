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

/**
 * The text of the first `<t ...>text</t>`: the same result as the regex
 * `<t[^>]*>([^<]*)</t>` (first match, group 1), in linear time. The regex restarts its
 * scan to the next ">" at every "<t", which is quadratic on an uploaded core.xml.
 * At a start "<t" the match can only end at the first ">" after it (g) and the first
 * "<" after g (l). When "</t>" is not at l, every later "<t" before g has the same
 * g and l, and no "<t" can contain g: the next candidate starts after g.
 */
export function elementText(xml: string, t: string): string | undefined {
  const open = `<${t}`;
  const close = `</${t}>`;
  let from = 0;
  for (;;) {
    const start = xml.indexOf(open, from);
    if (start < 0) return undefined;
    const g = xml.indexOf(">", start + open.length);
    if (g < 0) return undefined;
    const l = xml.indexOf("<", g + 1);
    if (l < 0) return undefined;
    if (xml.startsWith(close, l)) return xml.slice(g + 1, l);
    from = g + 1;
  }
}

async function coreProps(zip: JSZip): Promise<{ title?: string; author?: string; created?: string; modified?: string }> {
  const xml = await zip.file("docProps/core.xml")?.async("string");
  if (!xml) return {};
  const tag = (t: string) => {
    const m = elementText(xml, t);
    return m ? xmlText(m).trim() || undefined : undefined;
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

/**
 * The text between each `<a:p>` and the next `</a:p>`: what `/<a:p>([\s\S]*?)<\/a:p>/g` captured,
 * in one pass. The regex rescanned to the end of the slide from every `<a:p>` without a `</a:p>`.
 */
export function paragraphBodies(xml: string): string[] {
  const out: string[] = [];
  let open = xml.indexOf("<a:p>");
  while (open >= 0) {
    const close = xml.indexOf("</a:p>", open + 5);
    if (close < 0) break; // no later <a:p> has a closer either
    out.push(xml.slice(open + 5, close));
    open = xml.indexOf("<a:p>", close + 6);
  }
  return out;
}

/**
 * The [start, end) offsets of the first `<p:sp>…</p:sp>` with a title placeholder: what
 * `/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/` matched, in one pass.
 * Every `<p:sp>` before the same `</p:sp>` ends there and sees a part of the first one's range,
 * so only the first `<p:sp>` of each such group needs a check.
 */
export function titleShapeRange(xml: string): [number, number] | undefined {
  const placeholder = /<p:ph type="(?:title|ctrTitle)"/g;
  let ph = -1; // the first placeholder at or after the last `from` (Infinity: none); `from` only grows
  const nextPlaceholder = (from: number) => {
    if (ph < from) {
      placeholder.lastIndex = from;
      ph = placeholder.exec(xml)?.index ?? Infinity;
    }
    return ph;
  };
  let open = xml.indexOf("<p:sp>");
  while (open >= 0) {
    const close = xml.indexOf("</p:sp>", open + 6);
    if (close < 0) return undefined; // no later <p:sp> has a closer either
    if (nextPlaceholder(open + 6) < close) return [open, close + 7];
    open = xml.indexOf("<p:sp>", close + 7);
  }
  return undefined;
}

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
      paragraphBodies(xml)
        .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => xmlText(t[1]!)).join(""))
        .map((s) => s.trim())
        .filter(Boolean);
    const sections: string[] = [];
    for (const [i, f] of slideFiles.entries()) {
      const xml = await zip.file(f)!.async("string");
      // the title placeholder, if any
      const shape = titleShapeRange(xml);
      let title = shape ? paragraphs(xml.slice(shape[0], shape[1])).join(" ") : "";
      let body = paragraphs(shape ? xml.slice(0, shape[0]) + xml.slice(shape[1]) : xml);
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
