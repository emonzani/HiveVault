/**
 * Retraction of a document from the pages that cite it (llm-wiki "retract"), without a model:
 *
 * - a line whose citations are all to the retracted documents goes;
 * - a line that also cites other documents keeps its text and loses only those citations;
 * - a `> [!conflict]` block left with one value becomes a plain bullet (when the page has no
 *   bullet with that label yet), and with no value it goes;
 * - lines without citations (headings, text written by people) stay.
 *
 * The caller decides what to do with a page left without any citation.
 */
import { maskCode } from "@cb/brain";

export interface Stripped {
  body: string;
  /** Lines removed. */
  lines: number;
  /** Citations removed from lines that stay. */
  citations: number;
  /** Citations left in the page. */
  remaining: number;
}

const CITE = /\s?\^\[([^\]\n]+)\]/g;
const sourceOf = (ref: string) => ref.split("#")[0]!.trim();
const CALLOUT = /^>\s*\[!conflict\]\s*(.*)$/i;
const QUOTED_ITEM = /^>\s*[-*]\s+(.*)$/;

export function stripSources(body: string, ids: Set<string>): Stripped {
  const masked = maskCode(body).split("\n");
  const lines = body.split("\n");
  const out: string[] = [];
  let removed = 0;
  let citations = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // citations inside code are text, not citations
    const refs = [...masked[i]!.matchAll(CITE)].map((m) => ({ at: m.index!, len: m[0].length, source: sourceOf(m[1]!) }));
    const hit = refs.filter((r) => ids.has(r.source));
    if (!hit.length) {
      out.push(line);
      continue;
    }
    if (hit.length === refs.length) {
      removed++;
      continue;
    }
    let kept = line;
    for (const r of [...hit].sort((a, b) => b.at - a.at)) kept = kept.slice(0, r.at) + kept.slice(r.at + r.len);
    citations += hit.length;
    out.push(kept.replace(/\s+$/, ""));
  }
  const text = fixConflicts(out).join("\n").replace(/\n{3,}/g, "\n\n");
  const remaining = [...maskCode(text).matchAll(CITE)].length;
  return { body: text, lines: removed, citations, remaining };
}

/** Conflict blocks after the strip: one value left is a bullet, none is nothing. */
function fixConflicts(lines: string[]): string[] {
  const out: string[] = [];
  const labels = new Set(lines.map((l) => /^\s*[-*]\s+([^:\n]+):/.exec(l)?.[1]?.trim().toLowerCase()).filter(Boolean));
  for (let i = 0; i < lines.length; i++) {
    const head = CALLOUT.exec(lines[i]!);
    if (!head) {
      out.push(lines[i]!);
      continue;
    }
    let j = i + 1;
    const values: string[] = [];
    while (j < lines.length && /^>/.test(lines[j]!)) {
      const v = QUOTED_ITEM.exec(lines[j]!);
      if (v) values.push(v[1]!.trim());
      j++;
    }
    if (values.length >= 2) {
      out.push(...lines.slice(i, j));
    } else if (values.length === 1) {
      const label = head[1]!.trim();
      if (label && !labels.has(label.toLowerCase())) out.push(`- ${label}: ${values[0]}`);
    }
    i = j - 1;
  }
  return out;
}
