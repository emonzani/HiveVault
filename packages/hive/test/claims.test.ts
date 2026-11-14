import { describe, expect, it } from "vitest";
import { shortForms } from "@cb/brain";
import { crosslinkBody, entityKey, extractClaims, NOTE, normalizeValue, pickTargets, sameNumbers } from "../src/index.ts";

describe("claims from the compiled truth", () => {
  it("takes 'Label: value' bullets and counted quantities, only from Stato attuale", () => {
    const body = [
      "# Acme",
      "",
      "Introduzione con 99 postazioni che non conta.",
      "",
      "## Stato attuale",
      "- Usa [[Company example 2]] con **250 postazioni** a 31 € al mese ^[src_a#c1]",
      "- Referente tecnico: [[Nome CognomeAAA]] ^[src_a#c2]",
      "- Rinnovo del contratto: 01/03/2027 ^[src_a#c1]",
      "- Il cliente valuta il rinnovo anticipato",
      "- [ ] Contratto IT: in revisione",
      "",
      "## Timeline",
      "- Postazioni: 175",
    ].join("\n");
    const c = extractClaims(body);
    expect(c.map((x) => [x.predicate, x.valueNorm])).toEqual([
      ["postazioni", "250"],
      ["referente tecnico", "nome cognomeaaa"],
      ["rinnovo", "01 03 2027"],
      [NOTE, "il cliente valuta il rinnovo anticipato"],
      ["contratto it", "in revisione"],
    ]);
    expect(c[0]).toMatchObject({ blockId: "stato-attuale", cites: ["src_a#c1"] });
    expect(c[1]!.value).toBe("[[Nome CognomeAAA]]");
    expect(c[2]!.observedAt).toBe("2027-03-01");
  });

  it("normalizes numbers, wikilinks and synonyms of the labels", () => {
    expect(normalizeValue("1.250")).toBe(normalizeValue("1250"));
    expect(normalizeValue("[[Nome CognomeAAA|Nome]]")).toBe("nome");
    const c = extractClaims("## Stato attuale\n- Numero di postazioni: 1.250\n- Scadenza: 2027-03-01\n- 12 mesi di supporto");
    expect(c.map((x) => x.predicate)).toEqual(["postazioni", "rinnovo", NOTE]);
  });

  it("treats legal forms as the same entity", () => {
    expect(entityKey("ACME S.p.A.")).toBe(entityKey("Acme spa"));
    expect(entityKey("Beta S.r.l.")).toBe(entityKey("Beta srl"));
    expect(entityKey("Beta S.r.l.")).not.toBe(entityKey("Beta Gamma"));
  });

  it("does not take titles with different numbers for duplicates", () => {
    // parts of a standard, articles, versions: similar text, different things
    expect(sameNumbers("ETSI EN 319 522-1", "ETSI EN 319 522-4-1")).toBe(false);
    expect(sameNumbers("ETSI EN 319 522-4-2", "ETSI EN 319 522-4-3")).toBe(false);
    expect(sameNumbers("Art. 5 GDPR", "Art. 6 GDPR")).toBe(false);
    expect(sameNumbers("ETSI EN 319 522-2", "EN 319 522-2")).toBe(true);
    expect(sameNumbers("ACME S.p.A.", "Acme spa")).toBe(true);
  });
});

describe("unlinked mentions", () => {
  const targets = [
    { name: "Nome CognomeAAA", title: "Nome CognomeAAA", pageId: "p1" },
    { name: "Company example 2", title: "Company example 2", pageId: "p2" },
    { name: "Progetto Orione", title: "Progetto Orione", pageId: "p3" },
  ];
  it("links the first mention, leaves code, links, headings and citations alone", () => {
    const body = [
      "# Riunione con Nome CognomeAAA",
      "",
      "Nome CognomeAAA ha confermato [[Company example 2]]. Anche nome cognomeaaa in minuscolo no.",
      "Il codice `Progetto Orione` resta. Vedi ^[Progetto Orione] e https://x.it/Progetto Orione",
      "Poi il Progetto Orione parte. Nome CognomeAAA di nuovo.",
    ].join("\n");
    const r = crosslinkBody(body, "self", targets, new Set(["p2"]));
    expect(r.added).toBe(2);
    expect(r.body).toContain("# Riunione con Nome CognomeAAA\n");
    expect(r.body).toContain("[[Nome CognomeAAA]] ha confermato [[Company example 2]].");
    expect(r.body).toContain("`Progetto Orione`");
    expect(r.body).toContain("Poi il [[Progetto Orione]] parte. Nome CognomeAAA di nuovo.");
    expect(r.body).toContain("nome cognomeaaa in minuscolo");
    // twice: nothing more to do
    expect(crosslinkBody(r.body, "self", targets, new Set(["p1", "p2", "p3"])).added).toBe(0);
  });

  it("never links a page to itself", () => {
    expect(crosslinkBody("Company example 2 è il prodotto.", "p2", targets, new Set()).added).toBe(0);
  });

  it("links the short form of a standard to its full name", () => {
    const { targets: t } = pickTargets([{ id: "s1", title: "ETSI EN 319 522-2", aliases: null }]);
    const r = crosslinkBody("La firma segue EN 319 522-2 per la consegna.", "self", t, new Set());
    expect(r.body).toBe("La firma segue [[ETSI EN 319 522-2|EN 319 522-2]] per la consegna.");
    // the full name still wins over the short form inside it
    expect(crosslinkBody("Vedi ETSI EN 319 522-2.", "self", t, new Set()).body).toBe("Vedi [[ETSI EN 319 522-2]].");
  });
});

describe("short forms of names", () => {
  it("drops the issuing bodies before a standard code", () => {
    expect(shortForms("ETSI EN 319 522-2")).toEqual(["EN 319 522-2"]);
    expect(shortForms("UNI EN ISO 9001")).toEqual(["EN ISO 9001", "ISO 9001"]);
    expect(shortForms("ISO/IEC 27001")).toEqual([]); // "27001" alone is not a name
    expect(shortForms("EN 319 522-2")).toEqual([]);
    expect(shortForms("ETSI Security Group")).toEqual([]); // no code, not a standard
    expect(shortForms("Nome CognomeAAA")).toEqual([]);
  });

  it("gives explicit names priority and drops short forms of two pages", () => {
    const { targets: t, ambiguous } = pickTargets([
      { id: "a", title: "ETSI EN 319 522-2", aliases: null },
      { id: "b", title: "EN 319 522-2", aliases: null },
      { id: "c", title: "UNI EN ISO 9001", aliases: null },
      { id: "d", title: "CEI EN ISO 9001", aliases: null },
    ]);
    const names = new Map(t.map((x) => [x.name, x.pageId]));
    expect(names.get("EN 319 522-2")).toBe("b");
    expect(names.has("EN ISO 9001")).toBe(false);
    expect(names.has("ISO 9001")).toBe(false);
    expect(ambiguous).toBe(0);
  });

  it("links to a source page only on names no compiled page has", () => {
    const { targets: t, ambiguous } = pickTargets([
      { id: "cpt3", title: "ETSI EN 319 522-3", aliases: ["EN 319 522-3"] },
      { id: "src3", title: "EN 319 522-3 - V1.2.1 - Formats", aliases: ["EN 319 522-3", "ETSI EN 319 522-3"], source: true },
      { id: "src2", title: "EN 319 522-2 - V1.2.1 - Semantic contents", aliases: ["EN 319 522-2", "ETSI EN 319 522-2"], source: true },
      { id: "x1", title: "Report 2024 - A", aliases: ["Report A"], source: true },
      { id: "x2", title: "Report 2024 - B", aliases: ["Report A"], source: true },
    ]);
    const names = new Map(t.map((x) => [x.name, x.pageId]));
    expect(names.get("ETSI EN 319 522-3")).toBe("cpt3");
    expect(names.get("EN 319 522-3")).toBe("cpt3");
    expect(names.get("ETSI EN 319 522-2")).toBe("src2");
    expect(names.get("EN 319 522-2")).toBe("src2");
    expect(names.has("Report A")).toBe(false); // a name of two sources
    expect(ambiguous).toBe(1);
    const r = crosslinkBody("Il formato segue ETSI EN 319 522-2 e EN 319 522-3.", "self", t, new Set());
    // a source page is linked by the name, so a concept page that takes it later takes the link
    expect(r.body).toBe("Il formato segue [[ETSI EN 319 522-2]] e [[ETSI EN 319 522-3|EN 319 522-3]].");
  });

  it("does not link names a wikilink cannot carry, so a second night changes nothing", () => {
    const { targets: t } = pickTargets([
      { id: "s1", title: "Verbale riunione", aliases: ["Verbale [bozza].docx"], source: true },
      { id: "s2", title: "Offerta 12", aliases: ["Offerta #12.pdf", "Piano di lavoro.md"], source: true },
      { id: "c1", title: "Linguaggio C# avanzato", aliases: null },
    ]);
    expect(t.map((x) => x.name).sort()).toEqual(["Offerta 12", "Verbale riunione"]);
    const once = crosslinkBody("Vedi Verbale [bozza].docx, Offerta #12.pdf e Linguaggio C# avanzato.", "self", t, new Set()).body;
    expect(once).toBe("Vedi Verbale [bozza].docx, Offerta #12.pdf e Linguaggio C# avanzato.");
  });
});
