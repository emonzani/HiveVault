import type { Parser } from "../types.ts";
import { decodeText } from "../util.ts";

export const textParser: Parser = {
  id: "text",
  version: "1",
  async parse(data, ctx) {
    const text = decodeText(data).replace(/\r\n?/g, "\n");
    const isMd = /\.(md|markdown)$/i.test(ctx.name) || ctx.mime === "text/markdown";
    const title = isMd ? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() : undefined;
    return { markdown: text, ...(title ? { title } : {}), meta: { chars: text.length }, attachments: [], warnings: [] };
  },
};

const CODE_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", py: "python", java: "java", kt: "kotlin",
  cs: "csharp", go: "go", rs: "rust", rb: "ruby", php: "php", c: "c", h: "c", cpp: "cpp", hpp: "cpp", sql: "sql",
  sh: "bash", ps1: "powershell", yaml: "yaml", yml: "yaml", json: "json", xml: "xml", toml: "toml", swift: "swift", scala: "scala",
};
export const CODE_EXTENSIONS = Object.keys(CODE_LANG);

/**
 * Source code: kept verbatim in a fenced block. Top-level declarations become headings,
 * so the chunker splits a long file by symbol and search can cite "file › function".
 */
export const codeParser: Parser = {
  id: "code",
  version: "1",
  async parse(data, ctx) {
    const ext = ctx.name.split(".").pop()!.toLowerCase();
    const lang = CODE_LANG[ext] ?? "";
    const text = decodeText(data).replace(/\r\n?/g, "\n");
    const decl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:function|class|interface|type|enum|def|struct|impl|trait|func|fn)\s+([A-Za-z_$][\w$]*)/;
    const lines = text.split("\n");
    const parts: { name: string; start: number }[] = [];
    lines.forEach((l, i) => {
      const m = decl.exec(l);
      if (m) parts.push({ name: m[1]!, start: i });
    });
    let markdown: string;
    if (parts.length < 2 || lines.length < 80) {
      markdown = "```" + lang + "\n" + text + "\n```";
    } else {
      const head = lines.slice(0, parts[0]!.start).join("\n").trim();
      markdown = [head ? "```" + lang + "\n" + head + "\n```" : "", ...parts.map((p, i) => {
        const body = lines.slice(p.start, parts[i + 1]?.start ?? lines.length).join("\n").trimEnd();
        return `## ${p.name}\n\n` + "```" + lang + "\n" + body + "\n```";
      })].filter(Boolean).join("\n\n");
    }
    return { markdown, title: ctx.name, lang: "simple", meta: { language: lang, lines: lines.length, symbols: parts.map((p) => p.name).slice(0, 200) }, attachments: [], warnings: [] };
  },
};
