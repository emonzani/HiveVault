import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { CheckpointStore, isMassChange, PageStore, VaultStore } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
afterAll(async () => {
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();
const pages = () => new PageStore(sql!, { minTokens: 1 });

const page = (title: string, text: string) => `---\ntitle: ${title}\ntype: concept\n---\n${text}\n`;

describe("mass changes", () => {
  it("more than a fifth of a vault, and more than 5 pages, is a mass change", () => {
    expect(isMassChange(100, 20)).toBe(false);
    expect(isMassChange(100, 21)).toBe(true);
    expect(isMassChange(10, 5)).toBe(false);
    expect(isMassChange(10, 6)).toBe(true);
    expect(isMassChange(0, 0)).toBe(false);
  });
});

describe("CheckpointStore", () => {
  db()("restores changed, removed and new pages, and saves the state before the restore", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "cell", slug: `cp-${run}`, name: "cp" });
    const ps = pages();
    const a = (await ps.upsert({ vaultId: v.id, markdown: page("Alfa", "Prima versione di Alfa, collegata a [[Beta]].") })).page;
    const b = (await ps.upsert({ vaultId: v.id, markdown: page("Beta", "Beta resta uguale.") })).page;
    const c = (await ps.upsert({ vaultId: v.id, markdown: page("Gamma", "Gamma verrà cancellata.") })).page;
    // a hive page: rebuilt by the dream cycle, never in a checkpoint
    const hive = (await ps.upsert({ vaultId: v.id, markdown: `---\ntitle: Alveare\ntype: concept\nhive_subject: alveare\n---\nScritta di notte.\n` })).page;

    const store = new CheckpointStore(sql!, ps);
    const cp = await store.create(v.id, "Prima della pulizia", { by: null });
    expect(cp).toMatchObject({ name: "Prima della pulizia", kind: "manual", pages: 3 });

    await ps.upsert({ vaultId: v.id, id: a.id, markdown: page("Alfa", "Alfa riscritta male.") });
    await ps.delete(c.id);
    const d = (await ps.upsert({ vaultId: v.id, markdown: page("Delta", "Delta è nuova.") })).page;

    const r = await store.restore(cp.id, null);
    expect(r).toMatchObject({ restored: 2, removed: 1, unchanged: 1, skipped: [] });
    const now = await sql!<{ id: string; title: string; body: string }[]>`select id, title, body from pages where vault_id = ${v.id} order by title`;
    expect(now.map((p) => p.title)).toEqual(["Alfa", "Alveare", "Beta", "Gamma"]);
    expect(now.find((p) => p.id === a.id)?.body).toContain("Prima versione di Alfa");
    // Gamma comes back with its old id: links and citations to it work again
    expect(now.some((p) => p.id === c.id)).toBe(true);
    expect(now.some((p) => p.id === d.id)).toBe(false);
    expect(now.some((p) => p.id === hive.id)).toBe(true);
    expect((await PageStore.get(sql!, b.id))?.version).toBe(1);
    const [link] = await sql!<{ dst: string | null }[]>`select dst_page as dst from links where src_page = ${a.id}`;
    expect(link?.dst).toBe(b.id);

    // the restore can be undone: the automatic checkpoint has Delta and the bad Alfa
    const undo = (await store.get(r.undo))!;
    expect(undo).toMatchObject({ kind: "auto", pages: 3 });
    await store.restore(undo.id, null);
    const back = await sql!<{ title: string }[]>`select title from pages where vault_id = ${v.id} and not (frontmatter ? 'hive_subject') order by title`;
    expect(back.map((p) => p.title)).toEqual(["Alfa", "Beta", "Delta"]);
    expect((await PageStore.get(sql!, a.id))?.body).toContain("riscritta male");
  });

  db()("keeps the last 5 automatic checkpoints of a vault, and every manual one", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "cell", slug: `cp-keep-${run}`, name: "cp" });
    const store = new CheckpointStore(sql!, pages());
    await store.create(v.id, "manuale");
    for (let i = 0; i < 7; i++) await store.create(v.id, `auto ${i}`, { kind: "auto" });
    const list = await store.list(v.id);
    expect(list.filter((c) => c.kind === "auto").map((c) => c.name)).toEqual(["auto 6", "auto 5", "auto 4", "auto 3", "auto 2"]);
    expect(list.some((c) => c.name === "manuale")).toBe(true);
  });
});
