import { describe, expect, it } from "vitest";
import { estimateTokens } from "@cb/shared";
import { chunkMarkdown } from "../src/chunker.ts";
import {
  explicitBlocks,
  extractCitations,
  extractWikilinks,
  firstParagraph,
  normalizeTitle,
  parseDocument,
  sections,
  serializeDocument,
  slugify,
} from "../src/markdown.ts";

const PAGE = `---
title: Acme S.p.A.
aliases: [Acme, ACME spa]
tags: [cliente]
---

Cliente fintech dal 2024. Referente [[Nome CognomeAAA|Nome]].

## Stato attuale
- Contratto 500 posti ^[src_7f3a#c12]
- Vedi [[Progetto Atlas#Pianificazione]] e ![[logo.png]] ^stato1

\`\`\`
[[non un link]] ## non un titolo
\`\`\`

## Timeline
- 2026-10-22 · Call con [[Nome CognomeAAA]] \`[[nemmeno questo]]\`

### Dettagli
Testo.
`;

describe("markdown", () => {
  it("parses and serializes frontmatter", () => {
    const d = parseDocument(PAGE);
    expect(d.frontmatter).toMatchObject({ title: "Acme S.p.A.", aliases: ["Acme", "ACME spa"] });
    expect(d.body.startsWith("\nCliente fintech")).toBe(true);
    const again = parseDocument(serializeDocument(d.frontmatter, d.body));
    expect(again.frontmatter).toEqual(d.frontmatter);
  });

  it("tolerates a document without or with broken frontmatter", () => {
    expect(parseDocument("# Titolo").frontmatter).toEqual({});
    expect(parseDocument("---\n: : :\n---\ncorpo").body).toBe("corpo");
  });

  it("normalizes titles for link resolution", () => {
    expect(normalizeTitle("  Città  di   Forlì ")).toBe("citta di forli");
    expect(normalizeTitle("ACME S.p.A.")).toBe("acme s p a");
    expect(slugify("Progetto Atlas: fase 2")).toBe("progetto-atlas-fase-2");
  });

  it("extracts wikilinks with anchors, aliases and embeds, but not inside code", () => {
    const links = extractWikilinks(parseDocument(PAGE).body);
    expect(links.map((l) => [l.target, l.anchor, l.display, l.embed])).toEqual([
      ["Nome CognomeAAA", null, "Nome", false],
      ["Progetto Atlas", "Pianificazione", null, false],
      ["logo.png", null, null, true],
      ["Nome CognomeAAA", null, null, false],
    ]);
  });

  it("extracts citations", () => {
    expect(extractCitations(PAGE).map((c) => [c.source, c.chunk])).toEqual([["src_7f3a", "c12"]]);
  });

  it("builds sections with heading paths and ignores headings in code", () => {
    const s = sections(parseDocument(PAGE).body);
    expect(s.map((x) => [x.id, x.level, x.headingPath.join("/")])).toEqual([
      ["intro", 0, ""],
      ["stato-attuale", 2, "Stato attuale"],
      ["timeline", 2, "Timeline"],
      ["dettagli", 3, "Timeline/Dettagli"],
    ]);
  });

  it("parses the edge cases of the heading syntax", () => {
    const cases: [string, [string, number, string, number, number, number][]][] = [
      ["# Titolo", [["titolo", 1, "Titolo", 0, 8, 8]]],
      ["## Titolo chiuso ##", [["titolo-chiuso", 2, "Titolo chiuso", 0, 19, 19]]],
      ["### Titolo #  ", [["titolo", 3, "Titolo", 0, 14, 14]]],
      ["#\tTab\t#\t", [["tab", 1, "Tab", 0, 8, 8]]],
      ["###### Sei", [["sei", 6, "Sei", 0, 10, 10]]],
      ["####### Sette", [["intro", 0, "", 0, 0, 13]]],
      ["#Senza spazio", [["intro", 0, "", 0, 0, 13]]],
      ["# ", [["intro", 0, "", 0, 0, 2]]],
      ["#  ", [["pagina", 1, "", 0, 3, 3]]],
      ["# #", [["pagina", 1, "", 0, 3, 3]]],
      ["# C# e F#", [["c-e-f", 1, "C# e F", 0, 9, 9]]],
      ["# a # b", [["a-b", 1, "a # b", 0, 7, 7]]],
      ["# Titolo `#`", [["titolo", 1, "Titolo `#`", 0, 12, 12]]],
      ["# Titolo # ", [["titolo", 1, "Titolo", 0, 11, 11]]],
      ["# Uno\r\nTesto\r\n## Due ##\r\n", [["uno", 1, "Uno", 0, 7, 14], ["due", 2, "Due", 14, 25, 25]]],
      ["Intro\n\n```\n# non un titolo\n```\n## Dopo il codice\nTesto", [["intro", 0, "", 0, 0, 31], ["dopo-il-codice", 2, "Dopo il codice", 31, 49, 54]]],
      ["# A\n## A\n### B ###\n## A", [["a", 1, "A", 0, 4, 4], ["a-2", 2, "A", 4, 9, 9], ["b", 3, "B", 9, 19, 19], ["a-3", 2, "A", 19, 23, 23]]],
    ];
    for (const [body, expected] of cases) {
      expect(sections(body).map((s) => [s.id, s.level, s.title, s.headingStart, s.start, s.end]), JSON.stringify(body)).toEqual(expected);
    }
  });

  it("parses long heading lines in linear time", () => {
    const bodies = ["# a" + " ".repeat(49_990) + "b", "# " + "#".repeat(49_990) + " x", "# a" + " \t#".repeat(16_000) + "b"];
    for (const body of bodies) {
      const t = performance.now();
      const s = sections(body);
      expect(performance.now() - t).toBeLessThan(500);
      expect(s.map((x) => x.level)).toEqual([1]);
    }
  });

  it("finds explicit block ids", () => {
    const b = explicitBlocks(parseDocument(PAGE).body);
    expect(b.map((x) => x.id)).toEqual(["^stato1"]);
  });

  it("takes the first paragraph as tldr, without link syntax", () => {
    expect(firstParagraph(parseDocument(PAGE).body)).toBe("Cliente fintech dal 2024. Referente Nome.");
  });

  it("keeps the citations of nested, empty and unclosed brackets", () => {
    const cases: [string, [string, string, string | null, number][]][] = [
      ["a ^[src_1#c2] b ^[src_2] c", [["src_1#c2", "src_1", "c2", 2], ["src_2", "src_2", null, 16]]],
      ["^[a^[b]", [["a^[b", "a^[b", null, 0]]],
      ["^[^[^[x]", [["^[^[x", "^[^[x", null, 0]]],
      ["^[]^[a]", [["a", "a", null, 3]]],
      ["^[a\nb]^[c]", [["c", "c", null, 6]]],
      ["^[ src_1 # c3 # x ]", [[" src_1 # c3 # x ", "src_1", "c3", 0]]],
      ["^[a]]^[b", [["a", "a", null, 0]]],
      ["`^[code]` ^[real]", [["real", "real", null, 10]]],
      ["^[a|b]^[[c]]", [["a|b", "a|b", null, 0], ["[c", "[c", null, 6]]],
      ["^^[a]^[", [["a", "a", null, 1]]],
    ];
    for (const [body, expected] of cases) {
      expect(extractCitations(body).map((c) => [c.ref, c.source, c.chunk, c.offset])).toEqual(expected);
    }
  });

  it("keeps the tldr of nested, empty and unclosed brackets", () => {
    const cases: [string, string][] = [
      ["Vedi [[Pagina|testo]] e [[Altra]] ^[src_1#c1].", "Vedi testo e Altra ."],
      ["[[|[[a|b]]", "[[|b"],
      ["[[x|[[y|z]a]]", "[[x|[[y|z]a]]"],
      ["[[x|[[y|z]]", "[[y|z"],
      ["[[]] [[x|]] [[|y]] ^[]", "[[]] x| |y ^[]"],
      ["[[a|b|c]] [[[a]]", "b|c [a"],
      ["[[a\nb|c\nd]] fine", "c d fine"],
      ["[[a]b]] [[c|d]e]]", "[[a]b]] [[c|d]e]]"],
      ["^[a\nb] testo ^[c", "testo ^[c"],
      ["[[x| aperto", "[[x| aperto"],
      ["^[ aperto [[ aperto", "^[ aperto [[ aperto"],
      ["[[a|$1]] [[$&]]", "$1 $&"],
      ["- [[A|uno]]\n- ^[s] due", "uno due"],
    ];
    for (const [body, expected] of cases) expect(firstParagraph(body)).toBe(expected);
  });

  it("scans long unclosed citations and links in linear time", () => {
    // Quadratic scans take seconds at this size; linear scans take a few milliseconds.
    const n = 100_000;
    for (const body of ["^[".repeat(n), "[[".repeat(n), "[[x|".repeat(n / 2), "^[a\n".repeat(n / 2)]) {
      const t = performance.now();
      expect(extractCitations(body)).toEqual([]);
      expect(firstParagraph(body, body.length * 2)).toBe(body.replace(/\s+/g, " ").trim());
      expect(performance.now() - t).toBeLessThan(500);
    }
  });
});

describe("chunker", () => {
  const para = (n: number) => `Paragrafo ${n}. ` + "Il cliente conferma la consegna del progetto entro la fine del mese. ".repeat(6);

  it("keeps every chunk under maxTokens and covers all paragraphs", () => {
    const body = `# Verbale\n\n${Array.from({ length: 30 }, (_, i) => para(i)).join("\n\n")}`;
    const chunks = chunkMarkdown(body, { targetTokens: 300, maxTokens: 450 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(450);
    const all = chunks.map((c) => c.text).join("\n");
    for (let i = 0; i < 30; i++) expect(all).toContain(`Paragrafo ${i}.`);
  });

  it("adds overlap between consecutive chunks of the same section", () => {
    const body = `## A\n\n${Array.from({ length: 12 }, (_, i) => `Frase breve numero ${i} del verbale.`).join("\n\n")}`;
    const chunks = chunkMarkdown(body, { targetTokens: 40, maxTokens: 80, minTokens: 10, overlapRatio: 0.25 });
    expect(chunks.length).toBeGreaterThan(1);
    const lastOfFirst = chunks[0]!.text.split("\n\n").at(-1)!;
    expect(chunks[1]!.text.startsWith(lastOfFirst)).toBe(true);
  });

  it("never crosses an H2 boundary and records the heading path", () => {
    const body = `## Stato attuale\n\nUno.\n\n## Timeline\n\nDue.\n\n### Dettagli\n\nTre.`;
    const chunks = chunkMarkdown(body, { minTokens: 1 });
    expect(chunks.map((c) => c.heading)).toEqual(["Stato attuale", "Timeline", "Timeline › Dettagli"]);
    expect(chunks.map((c) => c.blockId)).toEqual(["stato-attuale", "timeline", "dettagli"]);
  });

  it("merges a tiny subsection into its parent chunk", () => {
    const body = `## Timeline\n\nEvento.\n\n### Dettagli\n\nTre parole qui.`;
    const chunks = chunkMarkdown(body, { minTokens: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("Evento.");
    expect(chunks[0]!.text).toContain("Tre parole qui.");
  });

  it("keeps a code fence with blank lines in one unit", () => {
    const body = "## Codice\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDopo il codice.";
    const chunks = chunkMarkdown(body, { minTokens: 1, targetTokens: 1000 });
    expect(chunks[0]!.text).toContain("const a = 1;\n\nconst b = 2;");
  });

  it("keeps every line of a code block without blank lines (aligned text, ASN.1)", () => {
    const code = "Network Working Group          C. Adams\nRequest for Comments: 3161      Entrust\nCategory: Standards Track       P. Cain";
    const chunks = chunkMarkdown(`## Pagina 1\n\n\`\`\`\n${code}\n\`\`\`\n\nTesto dopo.`, { minTokens: 1 });
    expect(chunks[0]!.text).toBe(`\`\`\`\n${code}\n\`\`\`\n\nTesto dopo.`);
  });

  it("splits a large code block by lines, every part inside its own fence", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `   field${i}    INTEGER  OPTIONAL,`);
    const chunks = chunkMarkdown(`## Codice\n\n\`\`\`asn1\n${lines.join("\n")}\n\`\`\``, { targetTokens: 100, maxTokens: 150, minTokens: 10 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text).toMatch(/^```asn1\n {3}field\d+[\s\S]*\n```$/);
      expect(c.tokens).toBeLessThanOrEqual(150);
    }
    const all = chunks.map((c) => c.text).join("\n");
    for (let i = 0; i < 80; i++) expect(all).toContain(`   field${i}    INTEGER`);
  });

  it("splits a large table by rows and repeats its header in every part", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| R${i} | valore della riga numero ${i} con testo |`);
    const body = `## Tabella\n\n| Codice | Descrizione |\n|---|---|\n${rows.join("\n")}`;
    const chunks = chunkMarkdown(body, { targetTokens: 100, maxTokens: 150, minTokens: 10 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text).toMatch(/^\| Codice \| Descrizione \|\n\|---\|---\|\n\| R\d+ /);
      expect(c.tokens).toBeLessThanOrEqual(150);
    }
    const all = chunks.map((c) => c.text).join("\n");
    for (let i = 0; i < 60; i++) expect(all).toContain(`| R${i} |`);
  });

  it("splits one huge paragraph by sentences", () => {
    const huge = Array.from({ length: 200 }, (_, i) => `Frase ${i} sul contratto.`).join(" ");
    const chunks = chunkMarkdown(huge, { targetTokens: 200, maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(310);
  });

  it("offsets point into the original body", () => {
    const body = `## A\n\nPrimo paragrafo.\n\nSecondo paragrafo.`;
    const [c] = chunkMarkdown(body, { minTokens: 1 });
    expect(body.slice(c!.start, c!.end)).toBe("Primo paragrafo.\n\nSecondo paragrafo.");
  });
});
