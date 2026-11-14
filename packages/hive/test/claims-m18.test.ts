// M18: labels with a product keep one predicate; claims without a date take the date of their source.
import { afterAll, describe, expect, it } from "vitest";
import { PageStore, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { newId, ulid } from "@cb/shared";
import { extractClaims, normalizePredicate, syncClaims, withSourceDates } from "../src/index.ts";

describe("predicates of the extraction labels", () => {
  it("a synonym of more words is also the start of a label", () => {
    expect(normalizePredicate("Numero di postazioni Orbit Analytics")).toBe("postazioni orbit analytics");
    expect(normalizePredicate("Postazioni Orbit Analytics")).toBe("postazioni orbit analytics");
    expect(normalizePredicate("Scadenza del contratto Atlas ERP")).toBe("rinnovo atlas erp");
    expect(normalizePredicate("Numero di postazioni")).toBe("postazioni");
  });

  it("one-word synonyms stay exact", () => {
    expect(normalizePredicate("Posti auto")).toBe("posti auto");
    expect(normalizePredicate("PM 2.5")).toBe("pm 2 5");
    expect(normalizePredicate("Scadenza fattura")).toBe("scadenza fattura");
  });
});

const sql: Sql | undefined = await setupTestDb();
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();
afterAll(async () => {
  await sql?.end();
});

describe("observed date of a claim", () => {
  db()("comes from the newest cited document when the text has none", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "cell", slug: `m18-${run}`, name: "M18" });
    // two documents with their own dates (@cb/hive does not depend on the source store)
    const source = async (meta: Record<string, string>) => {
      const id = newId("src");
      await sql!`insert into sources (id, vault_id, sha256, name, mime, size, origin, meta)
                 values (${id}, ${v.id}, ${id}, ${`${id}.md`}, 'text/markdown', 1, 'upload', ${sql!.json(meta)})`;
      return { id };
    };
    const a = await source({ date: "2025-02-17T10:00:00.000Z" });
    const b = await source({ created: "2025-08-08" });
    const body = `## Stato attuale\n\n- Postazioni: 975 ^[${a.id}#c0] ^[${b.id}#c2]\n- Scadenza: 2026-03-31 ^[${a.id}#c1]\n- Referente: Vittoria Serra ^[src_nessuno#c0]\n`;
    const dated = await withSourceDates(sql!, extractClaims(body));
    expect(dated.map((c) => [c.predicate, c.observedAt])).toEqual([
      ["postazioni", "2025-08-08"],
      ["rinnovo", "2026-03-31"], // a date in the text wins
      ["referente", null],
    ]);

    const page = await new PageStore(sql!, { minTokens: 1 }).upsert({ vaultId: v.id, markdown: `---\ntitle: Cliente ${run}\ntype: entity/company\n---\n${body}` });
    await syncClaims(sql!, { vaultIds: [v.id], pageIds: [page.page.id] });
    const [c] = await sql!<{ d: string }[]>`select to_char(observed_at, 'YYYY-MM-DD') as d from claims where page_id = ${page.page.id} and predicate = 'postazioni'`;
    expect(c!.d).toBe("2025-08-08");
  });
});
