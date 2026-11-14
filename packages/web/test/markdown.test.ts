import { describe, expect, it } from "vitest";
import { sections } from "@cb/brain";
import { renderMarkdown, renderPage, splitFrontmatter, stripHead } from "../src/lib/markdown.ts";
import type { CitationRef, OutLink } from "../src/lib/types.ts";

const link = (raw: string, target: string, pageId: string | null): OutLink => ({ raw, target, pageId, title: pageId ? target : null, vaultId: pageId ? "v1" : null });

describe("page rendering", () => {
  it("never renders raw HTML from the page (text written by a model or imported)", () => {
    const html = renderMarkdown(`Ciao <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n<iframe src="https://evil"></iframe>`);
    expect(html).not.toMatch(/<script|<img|<iframe|href="javascript:/i);
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes link targets, labels and citation refs", () => {
    const html = renderPage(`[[A"><b>x</b>|lab<i>el</i>]] ^[src"><b>#c1]`, [], []).html;
    expect(html).not.toMatch(/<b>|<i>/);
  });

  it("resolves wikilinks from the link table, marks missing pages, keeps anchors", () => {
    const r = renderPage(`# Titolo\n\nVedi [[Acme S.p.A.|Acme]], [[Progetto Atlas#Timeline]] e [[Nuova pagina]].`, [
      link("[[Acme S.p.A.|Acme]]", "acme s p a", "ent_1"),
      link("[[Progetto Atlas#Timeline]]", "progetto atlas", "ent_2"),
      link("[[Nuova pagina]]", "nuova pagina", null),
    ], []);
    expect(r.html).toContain('<a class="wl" href="#/p/ent_1" data-page="ent_1">Acme</a>');
    expect(r.html).toContain('data-page="ent_2" data-anchor="timeline"');
    expect(r.html).toContain('class="wl unresolved"');
    expect(r.html).toContain('data-create="Nuova pagina"');
    // the first "# Titolo" is shown by the view, not in the body
    expect(r.html).not.toContain("<h1");
  });

  it("numbers citations in order of first appearance and flags unknown sources", () => {
    const cites: CitationRef[] = [{ ref: "src_a#c3", kind: "source", id: "src_a", name: "contratto.pdf", excerpt: "…", chunkId: "src_a:3" }];
    const r = renderPage(`- uno ^[src_a#c3]\n- due ^[src_b#c1]\n- tre ^[src_a#c3]`, [], cites);
    expect([...r.citeOrder.entries()]).toEqual([["src_a#c3", 1], ["src_b#c1", 2]]);
    expect(r.html).toContain('class="cite" data-cite="src_a#c3" aria-label="Fonte 1: contratto.pdf">1</button>');
    expect(r.html).toContain('class="cite missing" data-cite="src_b#c1"');
  });

  it("gives headings the same ids as the server sections, repeats included", () => {
    const body = `# Acme\n\nIntro\n\n## Stato attuale\n- x\n\n## Timeline\n- y\n\n## Timeline\n- z\n\n### Perché è così?\n`;
    const r = renderPage(body, [], []);
    const server = sections(body).filter((s) => s.level >= 2).map((s) => s.id);
    expect(r.headings.map((h) => h.id)).toEqual(server);
    expect(r.html).toContain('<h2 id="timeline-2">');
  });

  it("renders callouts, task lists and block ids", () => {
    const html = renderMarkdown(`> [!conflict] Postazioni\n> Il contratto dice 250, una email 300.\n\n- [x] fatto\n- [ ] da fare\n\nUn paragrafo ^blocco-1`);
    expect(html).toContain('<blockquote class="callout callout-conflict"><p class="callout-title">Postazioni</p>');
    expect(html).toContain("Il contratto dice 250");
    expect(html).not.toContain("[!conflict]");
    expect(html).toMatch(/<li class="task"><input type="checkbox" class="task-box" disabled checked/);
    expect(html).toContain('id="^blocco-1"');
    expect(html).not.toContain("^blocco-1</");
  });

  it("opens external links in a new tab without referrer", () => {
    expect(renderMarkdown("Vedi https://example.com")).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it("splits frontmatter and strips the head of budgeted reads", () => {
    expect(splitFrontmatter("---\ntitle: A\n---\n# A\n\ntesto")).toEqual({ frontmatter: "title: A", body: "# A\n\ntesto" });
    expect(stripHead("# A\n\n> sintesi\n\n# A\n\n## Stato attuale\n- x")).toBe("## Stato attuale\n- x");
  });
});
