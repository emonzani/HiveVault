// Retraction of a document from the text of a page (A1), without a model.
import { describe, expect, it } from "vitest";
import { stripSources } from "../src/retract.ts";

const ids = new Set(["src_A", "src_A1"]);

describe("stripSources", () => {
  it("drops lines only the document supports and its citations in the other lines", () => {
    const body = ["# Acme", "", "## Stato attuale", "", "- Sede: Milano ^[src_A#c0]", "- Dipendenti: 40 ^[src_A#c1] ^[src_B#c0]", "- Allegato ^[src_A1#c0]", "", "Testo senza fonte."].join("\n");
    const r = stripSources(body, ids);
    expect(r.body).toBe(["# Acme", "", "## Stato attuale", "", "- Dipendenti: 40 ^[src_B#c0]", "", "Testo senza fonte."].join("\n"));
    expect(r).toMatchObject({ lines: 2, citations: 1, remaining: 1 });
  });

  it("a conflict block left with one value becomes a bullet; with none it goes", () => {
    const one = stripSources(["## Stato attuale", "", "- Sede: Milano ^[src_B]", "", "> [!conflict] Fatturato", "> - 10 M ^[src_A]", "> - 12 M ^[src_B]", ""].join("\n"), ids);
    expect(one.body).toContain("- Fatturato: 12 M ^[src_B]");
    expect(one.body).not.toContain("[!conflict]");
    // the page has a bullet with that label already: the block just goes
    const dup = stripSources(["- Fatturato: 12 M ^[src_B]", "", "> [!conflict] Fatturato", "> - 10 M ^[src_A]", "> - 12 M ^[src_B]"].join("\n"), ids);
    expect(dup.body.match(/Fatturato/g)).toHaveLength(1);
    const kept = stripSources(["> [!conflict] Sede", "> - Milano ^[src_B]", "> - Roma ^[src_C]"].join("\n"), ids);
    expect(kept.body).toContain("[!conflict]");
  });

  it("leaves citations inside code and other documents with a similar id", () => {
    const body = "```\nesempio ^[src_A#c0]\n```\n- Fatto ^[src_AB#c0]";
    const r = stripSources(body, ids);
    expect(r.body).toBe(body);
    expect(r.lines + r.citations).toBe(0);
  });
});
