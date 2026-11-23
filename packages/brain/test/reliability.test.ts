// Reliability of a page (A4) and its review date (A3), computed when it is read.
import { describe, expect, it } from "vitest";
import { addDays, reliability, reliabilityLine, reviewPeriod } from "../src/reliability.ts";

const base = {
  type: "entity/company",
  frontmatter: {} as Record<string, unknown>,
  createdAt: "2026-01-10",
  sourceDates: new Map([
    ["src_A", "2026-02-01"],
    ["src_B", "2026-03-01"],
  ]),
  reviewDays: {} as Record<string, unknown>,
  today: "2026-06-01",
};

describe("reliability", () => {
  it("counts sources and conflicts and gives a level", () => {
    const two = reliability({ ...base, body: "- Sede: Milano ^[src_A#c0]\n- Settore: logistica ^[src_B#c2]" });
    expect(two).toMatchObject({ sources: 2, conflicts: 0, newest: "2026-03-01", level: "alta", reviewDue: false, reviewAfter: null });
    expect(reliability({ ...base, body: "- Sede: Milano ^[src_A#c0]" }).level).toBe("media");
    expect(reliability({ ...base, body: "Nessuna fonte." }).level).toBe("bassa");
    const conflict = reliability({ ...base, body: "- A ^[src_A]\n- B ^[src_B]\n\n> [!conflict] Sede\n> - Milano ^[src_A]\n> - Roma ^[src_B]" });
    expect(conflict).toMatchObject({ conflicts: 1, level: "bassa" });
    // a synthesis cites pages: they count as sources
    expect(reliability({ ...base, body: "Vedi ^[ent_X#stato-attuale] e ^[ent_Y]" }).sources).toBe(2);
  });

  it("a confirmation counts only when it is not older than the newest cited document", () => {
    const body = "- Sede: Milano ^[src_A#c0]\n- Settore ^[src_B]";
    const fresh = reliability({ ...base, body: "- Sede ^[src_A]", frontmatter: { verified_by: "Anna", verified_at: "2026-02-15" } });
    expect(fresh.verified).toEqual({ by: "Anna", at: "2026-02-15" });
    expect(fresh.level).toBe("alta");
    expect(reliability({ ...base, body, frontmatter: { verified_by: "Anna", verified_at: "2026-02-15" } }).verified).toBeNull();
  });

  it("review date: frontmatter first, then the vault default by type or kind, from the latest of confirmation, document, creation", () => {
    const body = "- Sede ^[src_A]";
    expect(reviewPeriod("entity/company", {}, { entity: 90 })).toBe(90);
    expect(reviewPeriod("entity/company", {}, { entity: 90, "entity/company": 30 })).toBe(30);
    expect(reviewPeriod("entity/company", { review_every: 10 }, { entity: 90 })).toBe(10);
    expect(reviewPeriod("concept", {}, { entity: 90 })).toBeNull();

    const due = reliability({ ...base, body, reviewDays: { entity: 90 } });
    expect(due).toMatchObject({ reviewAfter: addDays("2026-02-01", 90), reviewDue: true, level: "bassa" });
    const confirmed = reliability({ ...base, body, reviewDays: { entity: 90 }, frontmatter: { verified_by: "Anna", verified_at: "2026-05-20" } });
    expect(confirmed).toMatchObject({ reviewAfter: "2026-08-18", reviewDue: false, level: "alta" });
    // an explicit date wins, and a confirmation after it closes it
    expect(reliability({ ...base, body, frontmatter: { review_after: "2026-04-01" } }).reviewDue).toBe(true);
    expect(reliability({ ...base, body, frontmatter: { review_after: "2026-04-01", verified_by: "Anna", verified_at: "2026-04-02" } }).reviewDue).toBe(false);
  });

  it("one line for the cloud agent", () => {
    const r = reliability({ ...base, body: "- Sede ^[src_A]", reviewDays: { entity: 30 } });
    expect(reliabilityLine(r)).toBe("affidabilità bassa · 1 fonte · da ricontrollare dal 2026-03-03");
  });
});
