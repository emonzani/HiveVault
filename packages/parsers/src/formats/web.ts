import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Parser } from "../types.ts";
import { decodeText } from "../util.ts";
import { turndown } from "./office.ts";

/** HTML (a saved page or a downloaded link): the readable article, as Markdown. */
export const htmlParser: Parser = {
  id: "html",
  version: "1",
  async parse(data, ctx) {
    const html = decodeText(data);
    const { document } = parseHTML(html);
    // scripts and styles never become text
    for (const el of [...document.querySelectorAll("script,style,noscript,iframe,svg")]) el.remove();
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 200 }).parse();
    const content = article?.content ?? document.body?.innerHTML ?? "";
    const markdown = turndown.turndown(content).replace(/\n{3,}/g, "\n\n").trim();
    const title = article?.title?.trim() || document.title?.trim() || ctx.name;
    const warnings = markdown.length < 100 ? ["little_text"] : [];
    return {
      markdown,
      title,
      meta: { byline: article?.byline ?? undefined, siteName: article?.siteName ?? undefined, excerpt: article?.excerpt?.slice(0, 300) ?? undefined },
      attachments: [],
      warnings,
    };
  },
};
