// Pages to review (A3), confirmation by a person (A4) and the nightly download of links (A6).
import { afterAll, describe, expect, it } from "vitest";
import { PageStore, reliabilityOf, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { Curator, lintVault, STEPS, verifyPage, type DreamDeps } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const db = () => (sql ? it : it.skip);
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const vaults = sql ? new VaultStore(sql, 16) : undefined;
afterAll(async () => {
  await sql?.end();
});

describe("review dates", () => {
  db()("the nightly lint queues the pages past their review date; a confirmation closes them", async () => {
    const v = await vaults!.create({ kind: "cell", slug: `rev-${run}`, name: "Ricontrollo" });
    await sql!`update vaults set review_days = ${sql!.json({ entity: 30 })} where id = ${v.id}`;
    const old = await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Vecchia ${run}\ntype: entity/company\n---\n## Stato attuale\n- Sede: Milano ^[src_x#c0]\n` });
    const fresh = await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Nuova ${run}\ntype: entity/company\n---\n## Stato attuale\n- Sede: Roma ^[src_y#c0]\n` });
    const own = await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Concetto ${run}\ntype: concept\nreview_after: 2020-01-01\n---\nFatto. ^[src_z#c0]\n` });
    await sql!`update pages set created_at = now() - interval '90 days' where id = ${old.page.id}`;
    const [person] = await sql!<{ id: string }[]>`
      insert into principals (id, kind, name, display_name) values (${`usr_${ulid()}`}, 'user', ${`rev-${run}`}, 'Anna Rossi') returning id`;

    const report = await lintVault(sql!, pages!, v.id);
    expect(report.review).toBe(2);
    const curator = new Curator(sql!, pages!);
    const items = await curator.list([v.id], { kind: "review" });
    expect(items.map((i) => i.pageId).sort()).toEqual([old.page.id, own.page.id].sort());
    const maint = (await PageStore.resolve(sql!, [v.id], "Manutenzione del vault"))[0]!;
    expect(maint.body).toContain(`## Pagine da ricontrollare\n- [[Concetto ${run}]] (dal 2020-01-01)`);
    expect((await reliabilityOf(sql!, [old.page.id, fresh.page.id])).get(old.page.id)).toMatchObject({ reviewDue: true, level: "bassa" });

    // resolving the item confirms the page: it counts as checked from today
    const item = items.find((i) => i.pageId === old.page.id)!;
    await curator.resolve(item.id, { done: true }, person!.id);
    const confirmed = (await PageStore.get(sql!, old.page.id))!;
    expect(confirmed.frontmatter).toMatchObject({ verified_by: "Anna Rossi", verified_at: new Date().toISOString().slice(0, 10) });
    expect((await reliabilityOf(sql!, [old.page.id])).get(old.page.id)).toMatchObject({ reviewDue: false, level: "alta" });

    // a confirmation from the page closes the open item too; the next lint supersedes nothing new
    await verifyPage(sql!, pages!, own.page.id, person!.id);
    expect(await curator.list([v.id], { kind: "review" })).toEqual([]);
    expect((await lintVault(sql!, pages!, v.id)).review).toBe(0);
    // generated pages are not confirmed
    await expect(verifyPage(sql!, pages!, maint.id, person!.id)).rejects.toThrow(/generata/);
  });
});

describe("link refresh step", () => {
  db()("downloads the links not checked for the set days, oldest first, and deletes replaced versions", async () => {
    const v = await vaults!.create({ kind: "cell", slug: `lnk-${run}`, name: "Link" });
    const add = async (id: string, checked: string | null, extra: Record<string, unknown> = {}) =>
      sql!`insert into sources (id, vault_id, sha256, name, mime, size, origin, path, meta, created_at)
           values (${id}, ${v.id}, ${ulid()}, 'x.html', 'text/html', 1, 'link', 'https://example.com/x', ${sql!.json({ ...(checked ? { checkedAt: checked } : {}), ...extra } as never)}, now() - interval '30 days')`;
    const ids = { old: `src_${ulid()}`, recent: `src_${ulid()}`, never: `src_${ulid()}`, replaced: `src_${ulid()}`, orphan: `src_${ulid()}` };
    await add(ids.old, "2026-01-01T00:00:00Z");
    await add(ids.recent, new Date().toISOString());
    await add(ids.never, null);
    await add(ids.replaced, "2020-01-01T00:00:00Z", { replacedBy: ids.old });
    // its newer download was deleted: the link is checked again, not frozen
    await add(ids.orphan, "2025-06-01T00:00:00Z", { replacedBy: `src_${ulid()}` });
    const seen: string[] = [];
    const step = STEPS.find((s) => s.name === "refresh")!;
    const deps: DreamDeps = {
      sql: sql!,
      pages: pages!,
      linkRefreshDays: 7,
      refreshLink: async (id) => (seen.push(id), id === ids.old ? "changed" : "same"),
      dropReplaced: async () => 1,
    };
    const out = await step.run({ deps, vaultId: v.id, kind: "cell", cursor: null, since: null, signal: new AbortController().signal, night: "2026-11-23" });
    expect(seen).toEqual([ids.orphan, ids.old, ids.never]);
    expect(out.report).toMatchObject({ uguali: 2, cambiati: 1, "versioni vecchie eliminate": 1 });
    // 0 days: the step does nothing
    const off = await step.run({ deps: { ...deps, linkRefreshDays: 0 }, vaultId: v.id, kind: "cell", cursor: null, since: null, signal: new AbortController().signal, night: "2026-11-23" });
    expect(off.report).toMatchObject({ saltato: "non configurato" });
  });
});
