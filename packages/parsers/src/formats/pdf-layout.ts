/**
 * PDF layout to Markdown. The text layer of pdf.js gives positioned runs of text; the operator
 * list gives the lines drawn on the page. From them:
 * - tables: the ruling lines form a grid, each cell gets the text inside it (merged cells where
 *   a border is missing); a table that continues on the next page is joined to the first part;
 * - headings: bigger or bold short lines, with the level from the numbering ("4.2.1");
 * - paragraphs: lines joined again, bold runs kept, list items on their own line;
 * - monospaced documents (RFC, plain text exports): ASCII layout kept for code and aligned text;
 * - running headers and footers (repeated on most pages) are removed.
 */
import { getResolvedPDFJS } from "unpdf";

type Mat = [number, number, number, number, number, number];

interface Glyph {
  x: number;
  /** Baseline, top-left origin. */
  y: number;
  w: number;
  size: number;
  str: string;
  bold: boolean;
  mono: boolean;
}

interface Line {
  y: number;
  x: number;
  end: number;
  size: number;
  glyphs: Glyph[];
}

interface HRule {
  y: number;
  x0: number;
  x1: number;
}
interface VRule {
  x: number;
  y0: number;
  y1: number;
}

export type Block =
  | { kind: "heading"; level: number; text: string; y: number }
  | { kind: "para"; text: string; y: number }
  | { kind: "code"; text: string; y: number }
  | { kind: "table"; rows: string[][]; y: number };

export interface PageLayout {
  lines: Line[];
  tables: { y: number; rows: string[][] }[];
  width: number;
  height: number;
  /** Characters of the text layer (scan detection). */
  chars: number;
}

// --------------------------------------------------------------------------------------------
// Reading a page
// --------------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- pdf.js objects are untyped here */
export async function readPage(pdf: any, n: number): Promise<PageLayout> {
  const pdfjs: any = await getResolvedPDFJS();
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const { h, v } = rulesOf(ops, pdfjs, vp.transform as Mat);
  const tc = await page.getTextContent();
  const fonts = new Map<string, { bold: boolean; mono: boolean }>();
  const fontOf = (name: string) => {
    let f = fonts.get(name);
    if (!f) {
      const o = page.commonObjs.has(name) ? page.commonObjs.get(name) : null;
      const label = `${o?.name ?? ""} ${o?.loadedName ?? ""} ${o?.fallbackName ?? ""} ${tc.styles[name]?.fontFamily ?? ""}`;
      f = { bold: !!(o?.bold || o?.black) || /bold|black|heavy|semibold/i.test(String(o?.name ?? "")), mono: !!o?.isMonospace || /courier|mono|consol/i.test(label) };
      fonts.set(name, f);
    }
    return f;
  };
  const glyphs: Glyph[] = [];
  let chars = 0;
  for (const it of tc.items as any[]) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    chars += it.str.trim().length;
    const m = pdfjs.Util.transform(vp.transform, it.transform) as Mat;
    // horizontal text only (rotated labels and watermarks would break the lines)
    if (Math.abs(m[1]) > Math.abs(m[0]) * 0.2 + 0.01) continue;
    const size = Math.hypot(m[2], m[3]) || Math.abs(m[0]);
    if (!size) continue;
    const f = fontOf(it.fontName);
    glyphs.push({ x: m[4], y: m[5], w: it.width, size, str: it.str.replace(/\s+/g, " "), bold: f.bold, mono: f.mono });
  }
  const tables: PageLayout["tables"] = [];
  const free = new Set(glyphs);
  for (const grid of grids(h, v)) {
    const t = fillGrid(grid, glyphs.filter((g) => free.has(g)));
    if (!t) continue;
    for (const g of t.used) free.delete(g);
    tables.push({ y: grid.top, rows: t.rows });
  }
  return { lines: toLines([...free]), tables, width: vp.width, height: vp.height, chars };
}

/** Axis-aligned lines drawn on the page (strokes, thin filled boxes, cell edges), in viewport space. */
function rulesOf(ops: { fnArray: number[]; argsArray: any[] }, pdfjs: any, view: Mat): { h: HRule[]; v: VRule[] } {
  const O = pdfjs.OPS;
  const h: HRule[] = [];
  const v: VRule[] = [];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const pt = (x: number, y: number): [number, number] => {
    const [ux, uy] = apply(ctm, x, y);
    return apply(view, ux, uy);
  };
  const seg = (a: [number, number], b: [number, number]) => {
    if (Math.abs(a[1] - b[1]) < 1 && Math.abs(a[0] - b[0]) >= 3) h.push({ y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
    else if (Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) >= 3) v.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
  };
  const box = (x0: number, y0: number, x1: number, y1: number, filled: boolean) => {
    const w = x1 - x0;
    const hh = y1 - y0;
    if (filled && hh <= 2.5 && w >= 3) h.push({ y: (y0 + y1) / 2, x0, x1 });
    else if (filled && w <= 2.5 && hh >= 3) v.push({ x: (x0 + x1) / 2, y0, y1 });
    else if (!filled && w >= 3 && hh >= 3) {
      // a stroked box: its four edges (shading is not a border: editors shade line by line)
      h.push({ y: y0, x0, x1 }, { y: y1, x0, x1 });
      v.push({ x: x0, y0, y1 }, { x: x1, y0, y1 });
    }
  };
  const PAINT = new Set([O.stroke, O.closeStroke, O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const FILLS = new Set([O.fill, O.eoFill]);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.transform) {
      const [a, b, c, d, e, f] = args as Mat;
      ctm = [ctm[0] * a + ctm[2] * b, ctm[1] * a + ctm[3] * b, ctm[0] * c + ctm[2] * d, ctm[1] * c + ctm[3] * d, ctm[0] * e + ctm[2] * f + ctm[4], ctm[1] * e + ctm[3] * f + ctm[5]];
    }
    else if (fn === O.constructPath) {
      const [paint, parts] = args as [number, ArrayLike<number>[] | undefined];
      if (!PAINT.has(paint) || !Array.isArray(parts)) continue;
      const filled = FILLS.has(paint);
      for (const d of parts) {
        if (!d || typeof d.length !== "number") continue;
        // one subpath: points in device space; 0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath
        let sub: [number, number][] = [];
        let curved = false;
        const flush = () => {
          if (sub.length >= 2 && !curved) {
            const xs = sub.map((p) => p[0]);
            const ys = sub.map((p) => p[1]);
            const axis = sub.every((p, k) => k === 0 || Math.abs(p[0] - sub[k - 1]![0]) < 1 || Math.abs(p[1] - sub[k - 1]![1]) < 1);
            if (axis && (sub.length === 4 || sub.length === 5)) box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), filled);
            else if (!filled) for (let k = 1; k < sub.length; k++) seg(sub[k - 1]!, sub[k]!);
          }
          sub = [];
          curved = false;
        };
        for (let k = 0; k < d.length; ) {
          const op = d[k]!;
          if (op === 0) {
            flush();
            sub.push(pt(d[k + 1]!, d[k + 2]!));
            k += 3;
          } else if (op === 1) {
            sub.push(pt(d[k + 1]!, d[k + 2]!));
            k += 3;
          } else if (op === 2) {
            curved = true;
            k += 7;
          } else if (op === 3) {
            curved = true;
            k += 5;
          } else {
            if (sub.length > 1 && (sub[0]![0] !== sub.at(-1)![0] || sub[0]![1] !== sub.at(-1)![1])) sub.push(sub[0]!);
            k += 1;
          }
        }
        flush();
      }
    } else if (fn === O.rectangle) {
      const [x, y, w, hh] = args as number[];
      const a = pt(x!, y!);
      const b = pt(x! + w!, y! + hh!);
      box(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), false);
    }
  }
  return { h, v };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --------------------------------------------------------------------------------------------
// Tables from ruling lines
// --------------------------------------------------------------------------------------------

interface Grid {
  xs: number[];
  ys: number[];
  h: HRule[];
  v: VRule[];
  top: number;
}

const TOL = 2;

/** Clusters close values; returns the cluster centers in order. */
function cluster(values: number[], tol: number): number[] {
  const out: number[][] = [];
  for (const x of [...values].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && x - last.at(-1)! <= tol) last.push(x);
    else out.push([x]);
  }
  return out.map((c) => c.reduce((s, x) => s + x, 0) / c.length);
}

function grids(h: HRule[], v: VRule[]): Grid[] {
  if (h.length < 2 || v.length < 2) return [];
  // union-find over rules: a horizontal and a vertical rule that touch are in the same table
  const all: (HRule | VRule)[] = [...h, ...v];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < h.length; i++) {
    for (let j = 0; j < v.length; j++) {
      const a = h[i]!;
      const b = v[j]!;
      if (b.x >= a.x0 - TOL && b.x <= a.x1 + TOL && a.y >= b.y0 - TOL && a.y <= b.y1 + TOL) parent[find(i)] = find(h.length + j);
    }
  }
  const groups = new Map<number, { h: HRule[]; v: VRule[] }>();
  all.forEach((r, i) => {
    const g = groups.get(find(i)) ?? { h: [], v: [] };
    if ("y" in r) g.h.push(r);
    else g.v.push(r);
    groups.set(find(i), g);
  });
  const out: Grid[] = [];
  for (const g of groups.values()) {
    const xs = cluster(g.v.map((r) => r.x), TOL);
    const ys = cluster(g.h.map((r) => r.y), TOL);
    if (xs.length < 2 || ys.length < 2) continue;
    out.push({ xs, ys, h: g.h, v: g.v, top: ys[0]! });
  }
  return out;
}

const idx = (edges: number[], x: number) => {
  for (let i = 0; i < edges.length - 1; i++) if (x < edges[i + 1]!) return i;
  return -1;
};

function fillGrid(g: Grid, glyphs: Glyph[]): { rows: string[][]; used: Glyph[] } | null {
  const R = g.ys.length - 1;
  const C = g.xs.length - 1;
  const left = g.xs[0]!;
  const right = g.xs[C]!;
  const top = g.ys[0]!;
  const bottom = g.ys[R]!;
  // a border between column c and c+1 in row r exists when a vertical rule covers the row middle
  const vBorder = (c: number, r: number) => {
    const x = g.xs[c + 1]!;
    const y = (g.ys[r]! + g.ys[r + 1]!) / 2;
    return g.v.some((s) => Math.abs(s.x - x) <= TOL && s.y0 - TOL <= y && s.y1 + TOL >= y);
  };
  // a border above row r in column c exists when a horizontal rule covers the column middle
  const hBorder = (r: number, c: number) => {
    const y = g.ys[r]!;
    const x = (g.xs[c]! + g.xs[c + 1]!) / 2;
    return g.h.some((s) => Math.abs(s.y - y) <= TOL && s.x0 - TOL <= x && s.x1 + TOL >= x);
  };
  const cells = new Map<string, Glyph[]>();
  const used: Glyph[] = [];
  for (const gl of glyphs) {
    const cx = gl.x + Math.min(gl.w, gl.size) / 2;
    const cy = gl.y - gl.size * 0.3;
    if (cx < left - 1 || cx > right + 1 || cy < top - 1 || cy > bottom + 1) continue;
    let r = idx(g.ys, cy);
    let c = idx(g.xs, cx);
    if (r < 0 || c < 0) continue;
    // merged cell: text goes to the first column, then the first row, of the span
    while (c > 0 && !vBorder(c - 1, r)) c--;
    while (r > 0 && !hBorder(r, c)) r--;
    const k = `${r}:${c}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(gl);
    used.push(gl);
  }
  if (!used.length) return null;
  let rows: string[][] = [];
  for (let r = 0; r < R; r++) {
    const row: string[] = [];
    for (let c = 0; c < C; c++) row.push(cellText(cells.get(`${r}:${c}`) ?? []));
    rows.push(row);
  }
  rows = rows.filter((row) => row.some((x) => x));
  const keep = Array.from({ length: C }, (_, c) => rows.some((row) => row[c]));
  rows = rows.map((row) => row.filter((_, c) => keep[c]));
  // a framed paragraph or a one-column box is not a table: its text stays in the flow
  if (rows.length < 2 || (rows[0]?.length ?? 0) < 2) return null;
  return { rows, used };
}

function cellText(gs: Glyph[]): string {
  if (!gs.length) return "";
  return toLines(gs)
    .map((l) => lineText(l, false))
    .reduce((acc, t) => joinLine(acc, t), "")
    .replace(/\|/g, "\\|")
    .trim();
}

// --------------------------------------------------------------------------------------------
// Lines and text
// --------------------------------------------------------------------------------------------

function toLines(glyphs: Glyph[]): Line[] {
  const sorted = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const g of sorted) {
    const l = lines.at(-1);
    if (l && Math.abs(g.y - l.y) <= Math.max(g.size, l.size) * 0.4) {
      l.glyphs.push(g);
      l.size = Math.max(l.size, g.size);
    } else lines.push({ y: g.y, x: 0, end: 0, size: g.size, glyphs: [g] });
  }
  for (const l of lines) {
    l.glyphs.sort((a, b) => a.x - b.x);
    l.x = l.glyphs[0]!.x;
    l.end = Math.max(...l.glyphs.map((g) => g.x + g.w));
  }
  return lines;
}

/** Text of a line; bold runs as **…** unless the whole line is bold (headings handle that). */
function lineText(l: Line, keepBold: boolean): string {
  const allBold = l.glyphs.every((g) => g.bold);
  const parts: { t: string; b: boolean }[] = [];
  let prevEnd = -Infinity;
  for (const g of l.glyphs) {
    const gap = g.x - prevEnd;
    const sep = prevEnd > -Infinity && gap > g.size * 0.15 ? " " : "";
    const b = keepBold && !allBold && g.bold;
    const last = parts.at(-1);
    if (last && last.b === b) last.t += sep + g.str;
    else {
      if (last) last.t += sep;
      parts.push({ t: g.str, b });
    }
    prevEnd = g.x + g.w;
  }
  return parts
    .map((p) => {
      if (!p.b) return p.t;
      const m = /^(\s*)(.*?)(\s*)$/.exec(p.t)!;
      return m[2] ? `${m[1]}**${m[2]}**${m[3]}` : p.t;
    })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Joins wrapped lines: a trailing hyphen joins without a space ("time-" + "stamp"). */
function joinLine(acc: string, t: string): string {
  if (!acc) return t;
  if (!t) return acc;
  return /\S-$/.test(acc) ? acc + t : `${acc} ${t}`;
}

// --------------------------------------------------------------------------------------------
// Document level: running headers, body size, blocks, Markdown
// --------------------------------------------------------------------------------------------

/** Lines at the top or bottom of a page that can be a running header or footer. */
const EDGE_LINES = 3;
const norm = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** The first and last lines repeated on many pages (numbers ignored): headers and footers. */
function runningLines(pages: PageLayout[]): Set<Line> {
  const out = new Set<Line>();
  if (pages.length < 3) return out;
  const edges = new Map(pages.map((p) => [p, new Set([...p.lines.slice(0, EDGE_LINES), ...p.lines.slice(-EDGE_LINES)])]));
  const edge = (p: PageLayout, l: Line) => edges.get(p)!.has(l);
  const count = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const l of p.lines) if (edge(p, l)) seen.add(norm(lineText(l, false)));
    for (const k of seen) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.4));
  for (const p of pages) for (const l of p.lines) if (edge(p, l) && (count.get(norm(lineText(l, false))) ?? 0) >= min) out.add(l);
  return out;
}

const NUMBERED = /^(?:(?:\d+|[A-Z])(?:\.\d+)+\.?|\d+\.?|Annex [A-Z]\b|Appendix [A-Z]\b|Allegato [A-Z]\b)\s+\S/;
const LIST = /^(?:[•▪◦●○■□‣⁃∙·–—-]|o(?=\s)|\(?[0-9]{1,2}[.)]|\(?[a-z][.)]|\([ivx]+\))\s+/;
const BULLET = /^(?:[•▪◦●○■□‣⁃∙·–—-]|o(?=\s))\s+/;

function headingLevel(text: string, size: number, body: number): number {
  const m = /^((?:\d+|[A-Z])(?:\.\d+)*)\.?\s/.exec(text);
  if (m && !/^\d+$/.test(m[1]!)) return Math.min(6, 2 + m[1]!.split(".").length);
  if (m) return 3;
  return size >= body * 1.4 ? 3 : 4;
}

/** Escapes what Markdown would read as markup in extracted prose (bold markers are ours). */
const escapeProse = (s: string) => s.replace(/`/g, "\\`").replace(/^([#>+])/, "\\$1").replace(/\[\[/g, "[\\[");

interface DocStats {
  body: number;
  mono: boolean;
  charW: number;
  left: number;
}

function stats(pages: PageLayout[], skip: Set<Line>): DocStats {
  const sizes = new Map<number, number>();
  let mono = 0;
  let all = 0;
  const widths: number[] = [];
  let left = Infinity;
  for (const p of pages)
    for (const l of p.lines) {
      if (skip.has(l)) continue;
      left = Math.min(left, l.x);
      for (const g of l.glyphs) {
        const n = g.str.length;
        const k = Math.round(g.size * 2) / 2;
        sizes.set(k, (sizes.get(k) ?? 0) + n);
        all += n;
        if (g.mono) {
          mono += n;
          if (n >= 3) widths.push(g.w / n);
        }
      }
    }
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  widths.sort((a, b) => a - b);
  return { body, mono: all > 0 && mono / all > 0.6, charW: widths[widths.length >> 1] ?? body * 0.6, left: Number.isFinite(left) ? left : 0 };
}

/** Blocks of a proportional-font page. */
function proseBlocks(lines: Line[], s: DocStats): Block[] {
  const out: Block[] = [];
  let cur: { lines: Line[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const ls = cur.lines;
    cur = null;
    const first = ls[0]!;
    const text = ls.reduce((acc, l) => joinLine(acc, lineText(l, true)), "");
    const plain = ls.reduce((acc, l) => joinLine(acc, lineText(l, false)), "");
    const allBold = ls.every((l) => l.glyphs.every((g) => g.bold));
    const big = first.size >= s.body * 1.15;
    const short = plain.length <= 160 && ls.length <= 3;
    if (short && (big || (allBold && NUMBERED.test(plain)))) {
      out.push({ kind: "heading", level: headingLevel(plain, first.size, s.body), text: escapeProse(plain), y: first.y });
    } else if (short && allBold) {
      out.push({ kind: "para", text: `**${escapeProse(plain)}**`, y: first.y });
    } else {
      const m = BULLET.exec(text);
      out.push({ kind: "para", text: m ? `- ${escapeProse(text.slice(m[0].length))}` : escapeProse(text), y: first.y });
    }
  };
  let prev: Line | null = null;
  for (const l of lines) {
    const t = lineText(l, false);
    const gap = prev ? l.y - prev.y : 0;
    const bold = l.glyphs.every((g) => g.bold);
    const prevBold = prev ? prev.glyphs.every((g) => g.bold) : bold;
    const breakHere =
      !cur ||
      !prev ||
      gap > Math.max(l.size, prev.size) * 1.6 ||
      gap < 0 ||
      Math.abs(l.size - prev.size) > 0.6 ||
      bold !== prevBold ||
      LIST.test(t) ||
      // a short previous line ends the paragraph when this one starts further left (new item)
      l.x < prev.x - l.size * 1.5;
    if (breakHere) {
      flush();
      cur = { lines: [] };
    }
    cur!.lines.push(l);
    prev = l;
  }
  flush();
  return out;
}

/** Blocks of a monospaced page: aligned text and code keep their columns. */
function monoBlocks(lines: Line[], s: DocStats): Block[] {
  const text = (l: Line) => {
    let out = "";
    for (const g of l.glyphs) {
      const col = Math.max(0, Math.round((g.x - s.left) / s.charW));
      if (out.length < col) out += " ".repeat(col - out.length);
      else if (out && !out.endsWith(" ")) out += " ";
      out += g.str;
    }
    return out.replace(/\s+$/, "");
  };
  const groups: { y: number; rows: string[] }[] = [];
  let prev: Line | null = null;
  for (const l of lines) {
    if (!prev || l.y - prev.y > prev.size * 1.6) groups.push({ y: l.y, rows: [] });
    groups.at(-1)!.rows.push(text(l));
    prev = l;
  }
  const out: Block[] = [];
  for (const g of groups) {
    const indent = Math.min(...g.rows.map((r) => r.length - r.trimStart().length));
    const rows = g.rows.map((r) => r.slice(indent));
    const codey = rows.filter((r) => /::=|[{}]|\S {3,}\S|\.{4,}/.test(r.trim().replace(LIST, ""))).length;
    const first = rows[0]!.trim();
    if (rows.length === 1 && indent === 0 && first.length <= 72 && !/[.,;:]$/.test(first) && /^[\dA-Z]/.test(first)) {
      out.push({ kind: "heading", level: headingLevel(first, s.body * 2, s.body), text: escapeProse(first.replace(/ {2,}/g, " ")), y: g.y });
    } else if (codey > 0 && codey >= rows.length * 0.3) {
      out.push({ kind: "code", text: rows.join("\n"), y: g.y });
    } else {
      // paragraphs and list items: a new item starts at the smallest indent with a marker
      let para = "";
      const emit = () => {
        if (!para) return;
        const m = BULLET.exec(para);
        out.push({ kind: "para", text: m ? `- ${escapeProse(para.slice(m[0].length))}` : escapeProse(para), y: g.y });
        para = "";
      };
      for (const r of rows) {
        if (para && !r.startsWith(" ") && LIST.test(r)) emit();
        para = joinLine(para, r.trim().replace(/ {2,}/g, " "));
      }
      emit();
    }
  }
  return out;
}

/** Same header row (case and spacing ignored). */
const cellKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const sameRow = (a: string[] | undefined, b: string[] | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => cellKey(x) === cellKey(b[i]!));

/** Pages of blocks; a table that continues at the top of the next page joins the previous part. */
export function layoutBlocks(pages: PageLayout[]): Block[][] {
  const skip = runningLines(pages);
  const s = stats(pages, skip);
  const out = pages.map((p) => {
    const lines = p.lines.filter((l) => !skip.has(l));
    const blocks = s.mono ? monoBlocks(lines, s) : proseBlocks(lines, s);
    for (const t of p.tables) {
      // title rows spanning the whole table (form fields, captions in the frame) go above it
      let rows = t.rows;
      let k = 0;
      while (rows.length > 2 && rows[0]!.slice(1).every((c) => !c)) {
        blocks.push({ kind: "para", text: rows[0]![0]!.replace(/\\\|/g, "|"), y: t.y - 1 + k++ / 1000 });
        rows = rows.slice(1);
      }
      blocks.push({ kind: "table", rows, y: t.y });
    }
    return blocks.sort((a, b) => a.y - b.y);
  });
  for (let i = out.length - 1; i > 0; i--) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    const last = prev.at(-1);
    if (last?.kind !== "table") continue;
    // the continuation is the first table of the page, after at most a repeated caption
    const k = cur.findIndex((b) => b.kind === "table");
    if (k < 0 || k > 3) continue;
    const t = cur[k] as Extract<Block, { kind: "table" }>;
    if (t.rows[0]?.length !== last.rows[0]?.length) continue;
    const before = cur.slice(0, k);
    // what precedes it must be a repeat of what preceded the first part (caption, table title)
    const prevTexts = new Set(prev.filter((b) => b.kind !== "table").map((b) => norm("text" in b ? b.text : "")));
    if (!before.every((b) => b.kind !== "table" && prevTexts.has(norm(b.text)))) continue;
    // repeated header rows are dropped
    let rows = t.rows;
    let h = 0;
    while (h < rows.length && h < 4 && sameRow(rows[h], last.rows[h])) h++;
    rows = rows.slice(h);
    last.rows.push(...rows);
    cur.splice(0, k + 1);
  }
  return out;
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case "heading":
          return `${"#".repeat(b.level)} ${b.text}`;
        case "code":
          return "```\n" + b.text.replace(/```/g, "``\u200b`") + "\n```";
        case "table": {
          const [head, ...rest] = b.rows;
          const n = head!.length;
          const row = (r: string[]) => `| ${Array.from({ length: n }, (_, i) => r[i] || " ").join(" | ")} |`;
          return [row(head!), `|${Array.from({ length: n }, () => "---").join("|")}|`, ...rest.map(row)].join("\n");
        }
        default:
          return b.text;
      }
    })
    .join("\n\n");
}
