/**
 * Markdown rendering of wiki pages (Obsidian flavour), safe by construction: raw HTML in the
 * page is never rendered (`html: false`), so text written by a model or imported from a file
 * cannot inject markup. Extensions:
 *   [[Target#Heading|label]]  wikilink, resolved with the page's link table (data-page)
 *   ![[Target]]               embed, shown as a link card
 *   ^[src_x#c3]               citation chip (numbered in order of first appearance)
 *   text ^block-id            block anchor (id="^block-id")
 *   > [!conflict] Title       callout
 *   - [ ] / - [x]             task list
 * Headings get the same ids as the server sections (slug of the title, -2, -3 for repeats).
 */
import MarkdownIt, { type StateCore, type StateInline, type Token } from "markdown-it";
import { normalizeTitle } from "./format.ts";
import type { CitationRef, OutLink } from "./types.ts";

import { t } from "./i18n.ts";
export interface RenderEnv extends Record<string, unknown> {
  /** Outgoing links of the page, by raw text ("[[Target|label]]"). */
  links?: Map<string, OutLink>;
  /** Fallback resolution by normalized title (hover previews, other vaults). */
  titles?: Map<string, OutLink>;
  citations?: Map<string, CitationRef>;
  /** Filled while rendering: citation ref → number. */
  citeOrder?: Map<string, number>;
  /** Filled while rendering: headings for the outline. */
  headings?: { id: string; level: number; title: string }[];
}

export function slugify(s: string): string {
  return normalizeTitle(s).replace(/\s+/g, "-").slice(0, 96) || "pagina";
}

const WIKILINK = /^(!?)\[\[([^[\]|#^\n]+?)?(?:#(\^?[^[\]|\n]+?))?(?:\|([^[\]\n]+?))?\]\]/;

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src.slice(state.pos);
  if (!src.startsWith("[[") && !src.startsWith("![[")) return false;
  const m = WIKILINK.exec(src);
  if (!m) return false;
  if (!silent) {
    const t = state.push("wikilink", "", 0);
    t.meta = { raw: m[0], embed: m[1] === "!", target: (m[2] ?? "").trim().replace(/\.md$/i, ""), anchor: m[3]?.trim() ?? null, display: m[4]?.trim() ?? null };
  }
  state.pos += m[0].length;
  return true;
}

function citationRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5e /* ^ */ || state.src.charCodeAt(state.pos + 1) !== 0x5b /* [ */) return false;
  const end = state.src.indexOf("]", state.pos + 2);
  if (end < 0) return false;
  const ref = state.src.slice(state.pos + 2, end);
  if (!ref || ref.includes("\n") || ref.length > 200) return false;
  if (!silent) {
    const t = state.push("citation", "", 0);
    t.meta = { ref: ref.trim() };
  }
  state.pos = end + 1;
  return true;
}

/** " ^block-id" at the end of a paragraph or list item → anchor. */
function blockIdRule(state: StateInline, silent: boolean): boolean {
  // "^" is a terminator of the text rule: this rule sees the position of "^", after the space
  if (state.src.charCodeAt(state.pos) !== 0x5e || !/\s/.test(state.src[state.pos - 1] ?? "")) return false;
  const m = /^\^([A-Za-z0-9-]+)[ \t]*$/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const t = state.push("block_id", "", 0);
    t.meta = { id: m[1] };
  }
  state.pos = state.posMax;
  return true;
}

/** Callouts: a blockquote whose first line is "[!type] Title". */
function calloutRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== "blockquote_open") continue;
    const inline = tokens[i + 2];
    if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const m = /^\[!([a-z-]+)\][+-]?[ \t]*([^\n]*)\n?/i.exec(inline.content);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    tokens[i]!.attrSet("class", `callout callout-${kind}`);
    tokens[i]!.meta = { callout: kind, title: m[2]?.trim() || CALLOUT_TITLE[kind] || kind };
    // drop the marker line from the first paragraph (it may be the whole paragraph)
    inline.content = inline.content.slice(m[0].length);
    // the marker line is every child before the first line break
    const children = inline.children ?? [];
    const br = children.findIndex((c) => c.type === "softbreak" || c.type === "hardbreak");
    inline.children = br < 0 ? [] : children.slice(br + 1);
  }
}

const CALLOUT_TITLE: Record<string, string> = {
  conflict: t("Informazioni in conflitto"),
  note: t("Nota"),
  info: t("Informazione"),
  tip: t("Suggerimento"),
  warning: t("Attenzione"),
  danger: t("Pericolo"),
  question: t("Domanda"),
  todo: t("Da fare"),
  quote: t("Citazione"),
  summary: t("Sintesi"),
};

/** Task lists: "[ ] " / "[x] " at the start of a list item. */
function taskRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "inline" || tokens[i - 1]?.type !== "paragraph_open" || tokens[i - 2]?.type !== "list_item_open") continue;
    const m = /^\[([ xX])\][ \t]+/.exec(t.content);
    if (!m) continue;
    tokens[i - 2]!.attrSet("class", "task");
    const first = t.children?.[0];
    if (first?.type === "text") first.content = first.content.slice(m[0].length);
    const box = new state.Token("task_box", "", 0);
    box.meta = { checked: m[1] !== " " };
    t.children?.unshift(box);
  }
}

/** Heading ids identical to the server section ids. */
function headingIdRule(state: StateCore): void {
  const used = new Map<string, number>();
  const env = state.env as RenderEnv;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "heading_open") continue;
    const inline = tokens[i + 1]!;
    const title = inline.content.trim();
    const base = slugify(title);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n + 1}`;
    t.attrSet("id", id);
    env.headings?.push({ id, level: Number(t.tag.slice(1)), title: plain(inline) });
  }
}

function plain(inline: Token): string {
  return (inline.children ?? [])
    .map((c) => (c.type === "wikilink" ? ((c.meta as { display: string | null; target: string }).display ?? (c.meta as { target: string }).target) : c.type === "citation" || c.type === "block_id" ? "" : c.content))
    .join("")
    .trim();
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.inline.ruler.before("link", "wikilink", wikilinkRule);
md.inline.ruler.before("link", "citation", citationRule);
md.inline.ruler.before("text", "block_id", blockIdRule);
md.core.ruler.after("inline", "callout", calloutRule);
md.core.ruler.after("inline", "task", taskRule);
md.core.ruler.after("inline", "heading_id", headingIdRule);

const esc = md.utils.escapeHtml;

md.renderer.rules.wikilink = (tokens, idx, _o, e) => {
  const env = (e ?? {}) as RenderEnv;
  const m = tokens[idx]!.meta as { raw: string; embed: boolean; target: string; anchor: string | null; display: string | null };
  const link = env.links?.get(m.raw) ?? env.titles?.get(normalizeTitle(m.target));
  const label = m.display ?? (m.target ? m.target + (m.anchor ? ` › ${m.anchor.replace(/^\^/, "")}` : "") : (m.anchor ?? ""));
  const anchor = m.anchor ? (m.anchor.startsWith("^") ? m.anchor : slugify(m.anchor)) : "";
  if (!m.target) return `<a class="wl" href="#${esc(anchor)}" data-anchor="${esc(anchor)}">${esc(label)}</a>`;
  // previews have no link table: show the link as text, not as a missing page
  if (!env.links && !env.titles) return `<span class="wl soft">${esc(label)}</span>`;
  if (!link?.pageId) {
    return `<a class="wl unresolved" href="#" data-create="${esc(m.target)}" title="${esc(t("Pagina non ancora scritta: clic per crearla"))}">${esc(label)}</a>`;
  }
  const cls = m.embed ? "wl embed" : "wl";
  return `<a class="${cls}" href="#/p/${esc(link.pageId)}" data-page="${esc(link.pageId)}"${anchor ? ` data-anchor="${esc(anchor)}"` : ""}>${esc(label)}</a>`;
};

md.renderer.rules.citation = (tokens, idx, _o, e) => {
  const env = (e ?? {}) as RenderEnv;
  const ref = (tokens[idx]!.meta as { ref: string }).ref;
  const order = env.citeOrder ?? new Map<string, number>();
  if (!order.has(ref)) order.set(ref, order.size + 1);
  const c = env.citations?.get(ref);
  const n = order.get(ref)!;
  // provenance of hive pages: a page of a cell the reader cannot open is not a broken source
  const cls = c && c.kind !== "unknown" ? "cite" : /^(ent|cpt|dec|syn|pag|spg)_/.test(ref) ? "cite private" : "cite missing";
  return `<button type="button" class="${cls}" data-cite="${esc(ref)}" aria-label="Fonte ${n}${c?.name ? `: ${esc(c.name)}` : ""}">${n}</button>`;
};

md.renderer.rules.block_id = (tokens, idx) => `<span class="block-id" id="^${esc((tokens[idx]!.meta as { id: string }).id)}"></span>`;

md.renderer.rules.task_box = (tokens, idx) => {
  const checked = (tokens[idx]!.meta as { checked: boolean }).checked;
  return `<input type="checkbox" class="task-box" disabled${checked ? " checked" : ""} aria-label="${checked ? t("Fatto") : t("Da fare")}"> `;
};

const defaultBq = md.renderer.rules.blockquote_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.blockquote_open = (tokens, idx, o, env, self) => {
  const meta = tokens[idx]!.meta as { callout?: string; title?: string } | null;
  if (!meta?.callout) return defaultBq(tokens, idx, o, env, self);
  return `<blockquote class="callout callout-${esc(meta.callout)}"><p class="callout-title">${esc(meta.title ?? "")}</p>`;
};

// external links open in a new tab, without referrer
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, o, env, self) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  if (/^https?:/i.test(href)) {
    tokens[idx]!.attrSet("target", "_blank");
    tokens[idx]!.attrSet("rel", "noopener noreferrer");
    tokens[idx]!.attrSet("class", "ext");
  }
  return defaultLink(tokens, idx, o, env, self);
};

export function renderMarkdown(body: string, env: RenderEnv = {}): string {
  env.citeOrder ??= new Map();
  env.headings ??= [];
  return md.render(body, env as Parameters<typeof md.render>[1]);
}

export interface RenderedPage {
  html: string;
  headings: { id: string; level: number; title: string }[];
  citeOrder: Map<string, number>;
}

/** Renders a page body without its first "# Title" line (the view shows the title itself). */
export function renderPage(body: string, links: OutLink[], citations: CitationRef[]): RenderedPage {
  const env: RenderEnv = {
    links: new Map(links.map((l) => [l.raw, l])),
    titles: new Map(links.filter((l) => l.pageId).map((l) => [l.target, l])),
    citations: new Map(citations.map((c) => [c.ref, c])),
    citeOrder: new Map(),
    headings: [],
  };
  const html = renderMarkdown(body.replace(/^\s*#\s+[^\n]*\n/, ""), env);
  return { html, headings: env.headings!, citeOrder: env.citeOrder! };
}

/**
 * A budgeted read (`/api/pages/:id`) starts with "# Title" and "> tldr", and the body often
 * repeats "# Title": previews show title and tldr themselves, so all three go.
 */
export function stripHead(content: string): string {
  return content.replace(/^#\s+[^\n]*\n+(?:>\s[^\n]*\n+)?(?:#\s+[^\n]*\n+)?/, "");
}

/** Splits "---\nfrontmatter\n---\nbody" (the editor works on the full Markdown file). */
export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  return m ? { frontmatter: m[1]!, body: markdown.slice(m[0].length) } : { frontmatter: "", body: markdown };
}
