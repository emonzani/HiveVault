/**
 * Markdown model of a page (Obsidian compatible): frontmatter, wikilinks,
 * citations, sections and addressable blocks. Line based and fast: it does not build a full
 * Markdown AST, but it respects code fences and inline code, where links are not links.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDocument(raw: string): ParsedDocument {
  const text = raw.replace(/^﻿/, "");
  const m = FM.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!) ?? {};
  } catch {
    fm = {};
  }
  return { frontmatter: typeof fm === "object" && fm !== null && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

export function serializeDocument(frontmatter: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));
  if (Object.keys(clean).length === 0) return body;
  return `---\n${stringifyYaml(clean, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}

/** Normal form for titles, aliases and link targets: case, accents and spacing do not matter. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function slugify(s: string): string {
  return normalizeTitle(s).replace(/\s+/g, "-").slice(0, 96) || "pagina";
}

// ---------------------------------------------------------------------------
// Masking: code fences and inline code are replaced by spaces of the same length, so that
// offsets stay valid and nothing inside code is taken for a link, heading or block id.
// ---------------------------------------------------------------------------
const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|$(?![\s\S]))/gm;

/**
 * Fenced blocks as one solid run of "x" (newlines included), same length as the body: the
 * chunker finds paragraph breaks on it, and a code block has none of its own.
 */
export function maskFencesSolid(body: string): string {
  return body.replace(FENCE, (m) => "x".repeat(m.length));
}

export function maskCode(body: string): string {
  let out = body.replace(FENCE, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
  return out;
}

export interface WikiLink {
  raw: string;
  target: string;
  /** "Heading" or "^blockid" */
  anchor: string | null;
  display: string | null;
  embed: boolean;
  offset: number;
}

const WIKILINK = /(!?)\[\[([^\[\]|#^\n]+?)?(?:#(\^?[^\[\]|\n]+?))?(?:\|([^\[\]\n]+?))?\]\]/g;

export function extractWikilinks(body: string): WikiLink[] {
  const masked = maskCode(body);
  const links: WikiLink[] = [];
  for (const m of masked.matchAll(WIKILINK)) {
    const target = m[2]?.trim();
    if (!target) continue; // [[#heading]]: link inside the same page
    links.push({
      raw: body.slice(m.index!, m.index! + m[0].length),
      target: target.replace(/\.md$/i, ""),
      anchor: m[3]?.trim() ?? null,
      display: m[4]?.trim() ?? null,
      embed: m[1] === "!",
      offset: m.index!,
    });
  }
  return links;
}

/** ^[src_7f3a#c12] -> { source: "src_7f3a", chunk: "c12" } */
export interface Citation {
  ref: string;
  source: string;
  chunk: string | null;
  offset: number;
}

export function extractCitations(body: string): Citation[] {
  const masked = maskCode(body);
  const out: Citation[] = [];
  // The closing "]" is optional and checked below: an unclosed "^[" consumes its run in one step.
  // With a required "]", every "^[" of a long unclosed run rescans it (quadratic time).
  for (const m of masked.matchAll(/\^\[([^\]\n]+)(\])?/g)) {
    if (!m[2]) continue;
    const [source, chunk] = m[1]!.split("#");
    out.push({ ref: m[1]!, source: source!.trim(), chunk: chunk?.trim() ?? null, offset: m.index! });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sections and blocks
// ---------------------------------------------------------------------------
export interface Section {
  /** Stable id from the heading path, unique in the page: "stato-attuale", "timeline-2". */
  id: string;
  level: number; // 0 = text before the first heading
  title: string;
  headingPath: string[];
  /** Offsets of the section content (after the heading line) in the body. */
  start: number;
  end: number;
  /** Offset of the heading line (= start for level 0). */
  headingStart: number;
}

/**
 * Heading text without the closing "#" sequence and the spaces around it. A loop from the
 * end instead of a regex: a backtracking regex is superlinear on long lines of "#" or spaces.
 */
function headingTitle(text: string): string {
  let end = text.trimEnd().length;
  while (end > 0 && text[end - 1] === "#") end--;
  return text.slice(0, end).trim();
}

export function sections(body: string): Section[] {
  const masked = maskCode(body);
  const heads: { level: number; title: string; lineStart: number; contentStart: number }[] = [];
  // The whole line after "# " in one greedy run: no adjacent quantifiers that overlap, so the
  // match is linear in the line length. headingTitle removes the closing hashes.
  const re = /^(#{1,6})[ \t].+$/gm;
  for (const m of masked.matchAll(re)) {
    const lineEnd = masked.indexOf("\n", m.index!);
    heads.push({
      level: m[1]!.length,
      title: headingTitle(body.slice(m.index! + m[1]!.length, m.index! + m[0].length)),
      lineStart: m.index!,
      contentStart: lineEnd < 0 ? body.length : lineEnd + 1,
    });
  }
  const out: Section[] = [];
  const used = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };
  const firstStart = heads[0]?.lineStart ?? body.length;
  if (firstStart > 0 && body.slice(0, firstStart).trim()) {
    out.push({ id: uniqueId("intro"), level: 0, title: "", headingPath: [], start: 0, end: firstStart, headingStart: 0 });
  }
  const stack: { level: number; title: string }[] = [];
  heads.forEach((h, i) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    stack.push({ level: h.level, title: h.title });
    // a section ends where the next heading of any level starts
    const end = heads[i + 1]?.lineStart ?? body.length;
    out.push({
      id: uniqueId(slugify(h.title)),
      level: h.level,
      title: h.title,
      headingPath: stack.map((s) => s.title),
      start: h.contentStart,
      end,
      headingStart: h.lineStart,
    });
  });
  return out;
}

export interface BlockRef {
  id: string;
  start: number;
  end: number;
}

/** Explicit Obsidian block ids: a paragraph or list item ending with " ^id". */
export function explicitBlocks(body: string): BlockRef[] {
  const masked = maskCode(body);
  const out: BlockRef[] = [];
  for (const m of masked.matchAll(/(?:^|\n)([^\n]*?)\s\^([A-Za-z0-9-]+)[ \t]*(?=\n|$)/g)) {
    const lineEnd = m.index! + m[0].length;
    // the block is the paragraph that ends on this line
    const before = body.lastIndexOf("\n\n", m.index!);
    const start = before < 0 ? 0 : before + 2;
    out.push({ id: `^${m[2]}`, start, end: lineEnd });
  }
  return out;
}

/** First paragraph of the body without headings: used as tldr when the frontmatter has none. */
export function firstParagraph(body: string, maxChars = 280): string {
  const masked = maskCode(body);
  for (const para of masked.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p || /^#{1,6}\s/.test(p) || /^[-*_]{3,}$/.test(p) || /^\|/.test(p) || /^\s*$/.test(p)) continue;
    const start = masked.indexOf(para);
    // Closing brackets are optional and checked in the callback (as in extractCitations): an
    // unclosed "[[" or "^[" is kept as it is, and its run is not scanned again (linear time).
    const text = body
      .slice(start, start + para.length)
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+)(\]\])?)?/g, (m: string, _t: string, display?: string, close?: string) => (close ? display! : m))
      .replace(/\[\[([^\]]+)(\]\])?/g, (m: string, target: string, close?: string) => (close ? target : m))
      .replace(/\^\[[^\]]+(\])?/g, (m: string, close?: string) => (close ? "" : m))
      .replace(/^[-*+]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  }
  return "";
}
