// M11: the automaton of the names finds what the regular expression of the names finds.
import { describe, expect, it } from "vitest";
import { crosslinkBody, NameAutomaton, pickTargets, targetIndex, type LinkTarget } from "../src/index.ts";

const both = (body: string, targets: LinkTarget[], linked = new Set<string>(), self = "self") => {
  const plain = crosslinkBody(body, self, targets, linked);
  const fast = crosslinkBody(body, self, targets, linked, 20, targetIndex({ targets, ambiguous: 0 }));
  return { plain, fast };
};

describe("NameAutomaton", () => {
  it("finds every occurrence, overlapping ones too", () => {
    const a = new NameAutomaton(["Orbit", "Orbit Analytics", "bit"]);
    const m = a.all("orbit analytics e orbit").map((x) => [x.start, x.length]);
    expect(m).toEqual(expect.arrayContaining([[0, 5], [0, 15], [2, 3], [18, 5], [20, 3]]));
  });

  it("refuses a text whose lower case has another length", () => {
    expect(NameAutomaton.lower("İstanbul")).toBeNull();
    expect(NameAutomaton.lower("Città")).toBe("città");
  });
});

describe("crosslink with the automaton", () => {
  const { targets } = pickTargets([
    { id: "p1", title: "Nome CognomeAAA", aliases: null },
    { id: "p2", title: "Company example 2", aliases: null },
    { id: "p3", title: "Progetto Orione", aliases: null },
    { id: "p4", title: "Orbit Analytics", aliases: ["Orbit"] },
    { id: "p5", title: "Orbit Analytics Cloud", aliases: null },
    { id: "s1", title: "ETSI EN 319 522-2", aliases: null },
    { id: "p6", title: "Società Àlfa", aliases: null },
  ]);
  const cases = [
    "# Riunione con Nome CognomeAAA\n\nNome CognomeAAA ha confermato [[Company example 2]]. Anche nome cognomeaaa no.\nIl codice `Progetto Orione` resta. Vedi ^[Progetto Orione] e https://x.it/Progetto Orione\nPoi il Progetto Orione parte.",
    "Orbit Analytics Cloud e Orbit Analytics e Orbit: il più lungo vince, poi gli altri.",
    "Orbital non è Orbit, e OrbitAnalytics nemmeno; orbit in minuscolo a inizio frase sì.",
    "La firma segue EN 319 522-2 e poi ETSI EN 319 522-2.",
    "La Società Àlfa e la società àlfa.",
    "Nessun nome qui.",
    "> [!conflict] Orbit Analytics\n> - Orbit Analytics resta il prodotto.",
  ];

  it("gives the same body as the regular expression", () => {
    for (const body of cases) {
      const { plain, fast } = both(body, targets);
      expect(fast).toEqual(plain);
    }
  });

  it("the same with linked pages and the page itself left out", () => {
    for (const body of cases) {
      const { plain, fast } = both(body, targets, new Set(["p5"]), "p4");
      expect(fast).toEqual(plain);
    }
    // the longest name is linked already: the shorter one at the same place is linked instead
    expect(both("Orbit Analytics Cloud è nuovo.", targets, new Set(["p5"])).fast.body).toBe("[[Orbit Analytics]] Cloud è nuovo.");
  });

  it("random texts made of pieces of the names: same result", () => {
    const pieces = ["Orbit", "orbit", "Analytics", "Cloud", "Nome", "CognomeAAA", "Progetto", "Orione", "ETSI", "EN", "319", "522-2", "Società", "Àlfa", "e", ",", ".", "_x", "[[Orbit]]", "`Orbit`", "\n", "# Orbit", "^[Orbit]"];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let k = 0; k < 400; k++) {
      const words = Array.from({ length: 3 + rnd(25) }, () => pieces[rnd(pieces.length)]!);
      const body = words.join(rnd(3) ? " " : "");
      const linked = new Set(rnd(2) ? ["p3"] : []);
      const { plain, fast } = both(body, targets, linked, rnd(3) ? "self" : "p4");
      expect(fast, body).toEqual(plain);
    }
  });

  it("a text with letters that change length in lower case uses the regular expression", () => {
    const { plain, fast } = both("İstanbul ospita Progetto Orione.", targets);
    expect(fast).toEqual(plain);
    expect(fast.added).toBe(1);
  });
});

describe("crosslink and classification", () => {
  const { targets } = pickTargets([
    { id: "p1", title: "Progetto Orione", aliases: null, classification: 0 },
    { id: "p2", title: "Orbit Analytics", aliases: null, classification: 1 },
    { id: "s1", title: "Acquisizione Beta S.r.l.", aliases: ["Phoenix"], classification: 3 },
  ]);
  const index = targetIndex({ targets, ambiguous: 0 });
  const link = (body: string, ceiling: number) => {
    const plain = crosslinkBody(body, "self", targets, new Set(), 20, undefined, ceiling);
    const fast = crosslinkBody(body, "self", targets, new Set(), 20, index, ceiling);
    expect(fast).toEqual(plain);
    return plain;
  };

  it("never writes the title of a page classified above the page", () => {
    expect(targets.find((t) => t.name === "Phoenix")).toMatchObject({ title: "Acquisizione Beta S.r.l.", classification: 3 });
    expect(link("Il progetto Phoenix parte.", 1)).toEqual({ body: "Il progetto Phoenix parte.", added: 0 });
    expect(link("Visto Acquisizione Beta S.r.l. oggi.", 2)).toEqual({ body: "Visto Acquisizione Beta S.r.l. oggi.", added: 0 });
    // a page at the same classification links it as before
    expect(link("Il progetto Phoenix parte.", 3).body).toBe("Il progetto [[Acquisizione Beta S.r.l.|Phoenix]] parte.");
  });

  it("keeps the links to pages at or below the classification of the page", () => {
    const body = "Phoenix usa Orbit Analytics nel Progetto Orione.";
    expect(crosslinkBody(body, "self", targets, new Set()).body).toBe("[[Acquisizione Beta S.r.l.|Phoenix]] usa [[Orbit Analytics]] nel [[Progetto Orione]].");
    expect(link(body, 1)).toEqual({ body: "Phoenix usa [[Orbit Analytics]] nel [[Progetto Orione]].", added: 2 });
    expect(link(body, 0)).toEqual({ body: "Phoenix usa Orbit Analytics nel [[Progetto Orione]].", added: 1 });
  });

  it("a target without a classification is linked only without a ceiling", () => {
    const t = [{ name: "Progetto Orione", title: "Progetto Orione", pageId: "p1" }];
    expect(crosslinkBody("Il Progetto Orione.", "self", t, new Set()).added).toBe(1);
    expect(crosslinkBody("Il Progetto Orione.", "self", t, new Set(), 20, undefined, 3).added).toBe(0);
  });
});
