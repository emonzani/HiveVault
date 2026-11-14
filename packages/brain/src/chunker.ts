/**
 * Structural chunker (plan §4.2 step 3): chunks follow the structure of the document.
 *
 * - Sections (headings) are the first boundary. A chunk never spans two H1/H2 sections;
 *   small deeper sections are merged with their neighbors.
 * - Inside a section the units are paragraphs, with code fences, tables and lists kept whole.
 *   A unit larger than `maxTokens` is split by sentences (or by lines for code and tables).
 * - Chunks target `targetTokens`, never exceed `maxTokens` (except for one unsplittable line),
 *   and carry ~10% overlap from the previous chunk of the same section.
 * - Every chunk keeps its heading path (indexed with weight A) and the id of its section block.
 */
import { estimateTokens } from "@cb/shared";
import { maskFencesSolid, sections, type Section } from "./markdown.ts";

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  minTokens?: number;
  overlapRatio?: number;
}

export interface Chunk {
  ord: number;
  text: string;
  heading: string;
  headingPath: string[];
  blockId: string;
  start: number;
  end: number;
  tokens: number;
}

interface Unit {
  text: string;
  start: number;
  end: number;
  tokens: number;
}

export const HEADING_SEPARATOR = " › ";

function units(body: string, masked: string, from: number, to: number, maxTokens: number): Unit[] {
  const out: Unit[] = [];
  const seg = masked.slice(from, to);
  // Paragraph boundaries on the masked text: blank lines inside code fences do not split.
  const re = /\n[ \t]*\n+/g;
  let last = 0;
  const push = (a: number, b: number) => {
    const raw = body.slice(from + a, from + b);
    const text = raw.trim();
    if (!text) return;
    const lead = raw.indexOf(text);
    out.push({ text, start: from + a + lead, end: from + a + lead + text.length, tokens: estimateTokens(text) });
  };
  for (const m of seg.matchAll(re)) {
    // a fenced block is masked solid: it contains no paragraph break of its own, keep it whole
    push(last, m.index!);
    last = m.index! + m[0].length;
  }
  push(last, seg.length);
  // Merge consecutive list items / table rows split by blank lines? Markdown lists with blank
  // lines are "loose lists": keep them as separate units, they read well alone.
  return out.flatMap((u) => (u.tokens > maxTokens ? splitLarge(u, maxTokens) : [u]));
}

function splitLarge(u: Unit, maxTokens: number): Unit[] {
  const isBlock = /^(```|~~~|\|)/.test(u.text);
  // code and tables: by lines; prose: by sentences
  let parts = isBlock ? u.text.split(/(?<=\n)/) : u.text.split(/(?<=[.!?;:])\s+(?=[A-ZÀ-Ý0-9"«(\[])/u);
  // a table split in parts repeats its header row: every part stays a table that reads alone
  let header = /^\|/.test(u.text) && /^\|[\s:|-]+\|\s*$/.test(parts[1] ?? "") ? parts[0]! + parts[1]! : "";
  // a code block split in parts: each part opens and closes the fence
  let footer = "";
  const fence = /^(```|~~~)/.exec(u.text)?.[1];
  if (fence && parts.length > 2 && parts.at(-1)!.startsWith(fence)) {
    header = parts[0]!;
    footer = "\n" + fence;
    parts = parts.slice(1, -1);
  } else if (header) parts = parts.slice(2);
  const out: Unit[] = [];
  let buf = "";
  let bufStart = u.start;
  let cursor = u.start + header.length;
  const flush = () => {
    const t = fence && footer ? buf.replace(/\n$/, "") : buf.trim();
    if (t.trim()) out.push({ text: header + t + footer, start: bufStart, end: bufStart + buf.length, tokens: estimateTokens(header + t + footer) });
    buf = "";
  };
  const budget = maxTokens - estimateTokens(header + footer);
  for (const p of parts) {
    const pos = u.text.indexOf(p, cursor - u.start) + u.start;
    if (buf && estimateTokens(buf + p) > budget) {
      flush();
      bufStart = pos;
    }
    if (!buf) bufStart = pos;
    buf += (buf && !isBlock ? " " : "") + p;
    cursor = pos + p.length;
  }
  flush();
  return out;
}

export function chunkMarkdown(body: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 500;
  const max = opts.maxTokens ?? 800;
  const min = opts.minTokens ?? 60;
  const overlapTokens = Math.floor(target * (opts.overlapRatio ?? 0.1));
  const masked = maskFencesSolid(body);
  const secs: Section[] = sections(body);
  if (secs.length === 0 && body.trim()) {
    secs.push({ id: "intro", level: 0, title: "", headingPath: [], start: 0, end: body.length, headingStart: 0 });
  }

  const chunks: Chunk[] = [];
  let cur: { units: Unit[]; sec: Section } | null = null;
  const tokensOf = (us: Unit[]) => us.reduce((n, u) => n + u.tokens, 0);
  const emit = () => {
    if (!cur || cur.units.length === 0) return;
    const us = cur.units;
    chunks.push({
      ord: chunks.length,
      text: us.map((u) => u.text).join("\n\n"),
      heading: cur.sec.headingPath.join(HEADING_SEPARATOR),
      headingPath: cur.sec.headingPath,
      blockId: cur.sec.id,
      start: us[0]!.start,
      end: us.at(-1)!.end,
      tokens: tokensOf(us),
    });
  };
  const overlapFrom = (us: Unit[]): Unit[] => {
    if (overlapTokens <= 0) return [];
    const out: Unit[] = [];
    let n = 0;
    for (let i = us.length - 1; i >= 0 && n < overlapTokens; i--) {
      if (us[i]!.tokens > overlapTokens) break;
      out.unshift(us[i]!);
      n += us[i]!.tokens;
    }
    return out.length === us.length ? [] : out; // never repeat a whole chunk
  };

  for (const sec of secs) {
    const us = units(body, masked, sec.start, sec.end, max);
    if (us.length === 0) continue;
    // Major sections (H1/H2) always start a new chunk; small deeper sections can join.
    const sameMajor = cur && sec.level > 2 && cur.sec.headingPath[0] === sec.headingPath[0] && (cur.sec.level > 2 || cur.sec.headingPath.length < sec.headingPath.length);
    if (cur && !(sameMajor && tokensOf(cur.units) < min)) {
      emit();
      cur = null;
    }
    if (!cur) cur = { units: [], sec };
    for (const u of us) {
      if (cur.units.length && tokensOf(cur.units) + u.tokens > target && tokensOf(cur.units) >= min) {
        emit();
        const carry: Unit[] = cur.sec === sec ? overlapFrom(cur.units) : [];
        cur = { units: carry, sec };
        if (tokensOf(carry) + u.tokens > max) cur.units = [];
      }
      cur.units.push(u);
      if (cur.sec !== sec && tokensOf(cur.units) >= min) cur.sec = sec; // merged: the chunk now belongs to the deeper section
    }
  }
  emit();
  return chunks;
}
