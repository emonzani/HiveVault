// Names of the pages found in a source before the model reads it (M5), duplicate keys (M6),
// sections of long documents (M8).
import { describe, expect, it } from "vitest";
import { dedupKey, NameMatcher } from "../src/names.ts";
import { mergeEntities, parseSections, type ExtractedEntity } from "../src/extract.ts";

describe("NameMatcher", () => {
  const m = new NameMatcher([
    { name: "Orbit Analytics", page: 0 },
    { name: "Orbit", page: 1 },
    { name: "Vittoria Serra", page: 2 },
    { name: "ETSI EN 319 522-2", page: 3 },
  ]);

  it("finds every name on whole words, in order of first mention", () => {
    expect(m.find("Vittoria Serra ha rinnovato Orbit Analytics.")).toEqual([2, 1, 0]);
    expect(m.find("La norma ETSI EN 319 522-2 si applica.")).toEqual([3]);
  });

  it("does not match inside a longer word or a different number", () => {
    expect(m.find("Il modulo Orbital e Serra Vittoria.")).toEqual([]);
    expect(m.find("ETSI EN 319 522-1")).toEqual([]);
  });
});

describe("dedupKey", () => {
  it("ignores the legal form, and for companies a generic word", () => {
    expect(dedupKey("Salentina Costruzioni Group", "entity/company")).toBe(dedupKey("Salentina Costruzioni S.r.l.", "entity/company"));
    expect(dedupKey("ACME S.p.A.", "entity/company")).toBe("acme");
  });

  it("keeps numbers, people and other types apart", () => {
    expect(dedupKey("Lotto 3 S.r.l.", "entity/company")).not.toBe(dedupKey("Lotto 4 S.r.l.", "entity/company"));
    expect(dedupKey("Mario Group", "entity/person")).toBe("mario group");
    expect(dedupKey("Gruppo di lavoro", "concept")).toBeNull();
  });
});

describe("mergeEntities with keys", () => {
  const e = (title: string, type = "entity/company"): ExtractedEntity => ({ title, type, aliases: [], tldr: "", facts: [{ label: "Sede", value: title, chunk: 0 }], events: [] });

  it("two titles of one company in one source are one entity", () => {
    const m = mergeEntities([[e("Salentina Costruzioni S.r.l.")], [e("Salentina Costruzioni Group")]]);
    expect(m).toHaveLength(1);
    expect(m[0]!.aliases).toContain("Salentina Costruzioni Group");
  });

  it("the same key on different types stays two entities", () => {
    expect(mergeEntities([[e("Atlas S.p.A.")], [e("Atlas", "entity/product")]])).toHaveLength(2);
  });
});

describe("parseSections", () => {
  it("keeps one sentence for each known section start", () => {
    const text = '{"entities": [], "sections": [{"chunk": 3, "text": "Condizioni economiche del contratto."}, {"chunk": "c9", "text": "Allegati tecnici e firme."}, {"chunk": 5, "text": "Inventata ma non è un inizio."}, {"chunk": 3, "text": "Doppia."}]}';
    const s = parseSections(text, new Set([3, 9]));
    expect([...s]).toEqual([
      [3, "Condizioni economiche del contratto."],
      [9, "Allegati tecnici e firme."],
    ]);
    expect(parseSections("niente", new Set([1])).size).toBe(0);
  });
});
