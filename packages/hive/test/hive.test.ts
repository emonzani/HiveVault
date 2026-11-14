// Acceptance of phase 5 (plan §10): two cells with agreeing and disagreeing information give a
// hive page with provenance and an open conflict; a curator decision is applied; a statement
// retracted in a cell leaves the hive; private pages never leave their cell.
import { afterAll, describe, expect, it } from "vitest";
import { PageStore, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { Curator, mergePages, promoteSpace, setFeeds, syncClaims } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
afterAll(async () => {
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const vaults = sql ? new VaultStore(sql, 16) : undefined;
const curatorId = `usr_hive_${run}`;
if (sql) await sql`insert into principals (id, kind, name, display_name, role) values (${curatorId}, 'user', ${`cur-${run}`}, 'Curatore', 'curator')`;

const page = (title: string, current: string[], extra = "", type = "entity/company") =>
  `---\ntitle: ${title}\ntype: ${type}\n${extra}---\n# ${title}\n\n## Stato attuale\n${current.map((c) => `- ${c}`).join("\n")}\n`;

async function hivePage(spaceId: string) {
  const [p] = await sql!<{ id: string; title: string; body: string; frontmatter: Record<string, unknown>; version: number; classification: number }[]>`
    select id, title, body, frontmatter, version, classification from pages where vault_id = ${spaceId} and frontmatter ? 'hive_subject'`;
  return p;
}

describe("hive promotion", () => {
  db()("agreeing values merge with their sources, different values open a conflict, decisions and retractions propagate", async () => {
    const a = await vaults!.create({ kind: "cell", slug: `hca-${run}`, name: "Cella di Nome CognomeKKK" });
    const b = await vaults!.create({ kind: "cell", slug: `hcb-${run}`, name: "Cella di Nome CognomeNNN" });
    const space = await vaults!.create({ kind: "space", slug: `hsp-${run}`, name: "Clienti" });
    const acme = `Acme ${run} S.p.A.`;
    const pa = await pages!.upsert({
      vaultId: a.id,
      markdown: page(acme, ["Usa [[Company example 2]] con **250 postazioni** ^[src_x#c1]", "Referente tecnico: [[Nome CognomeAAA]] ^[src_x#c2]", "Rinnovo: 01/03/2027 ^[src_x#c1]"], `aliases: [Acme ${run}]\n`),
    });
    const pb = await pages!.upsert({
      vaultId: b.id,
      markdown: page(`Acme ${run}`, ["Postazioni: 250", "Referente tecnico: [[Nome CognomeNNN]]", "Ha chiesto una revisione della sicurezza"]),
    });
    // a private page and a page of a type that the feed does not take
    await pages!.upsert({ vaultId: a.id, markdown: page(`Segreto ${run}`, ["Budget: 1 milione"], "visibility: privato\n") });
    await pages!.upsert({ vaultId: a.id, markdown: page(`Idea ${run}`, ["Stato: bozza"], "", "note") });
    await setFeeds(sql!, space.id, [{ cellId: a.id }, { cellId: b.id }]);

    const r1 = await promoteSpace(sql!, pages!, space.id);
    expect(r1).toMatchObject({ subjects: 1, written: 1, conflicts: 1 });
    const h = (await hivePage(space.id))!;
    expect(h.title).toBe(acme);
    expect(h.frontmatter).toMatchObject({ hive_subject: expect.stringContaining("acme"), promoted_from: [a.id, b.id].sort(), sources_count: 2 });
    // agreeing: one line, both sources, provenance ^[page#block]
    expect(h.body).toContain(`- Postazioni: 250 ^[${pa.page.id}#stato-attuale] ^[${pb.page.id}#stato-attuale] · 2 fonti concordi`);
    expect(h.body).toContain(`- Rinnovo: 01/03/2027 ^[${pa.page.id}#stato-attuale]`);
    // disagreeing: a conflict block with both values and their cells
    expect(h.body).toContain("> [!conflict] Referente tecnico");
    expect(h.body).toContain(`> - [[Nome CognomeAAA]] ^[${pa.page.id}#stato-attuale] — Cella di Nome CognomeKKK`);
    expect(h.body).toContain(`> - [[Nome CognomeNNN]] ^[${pb.page.id}#stato-attuale] — Cella di Nome CognomeNNN`);
    expect(h.body).toContain("## Altre informazioni\n- Ha chiesto una revisione della sicurezza");
    expect(h.body).toContain("## Provenienza\n- Cella di Nome CognomeKKK");
    // private and unfed pages stay in their cell
    expect(h.body).not.toContain("Budget");
    expect(h.body).not.toContain("bozza");
    const [{ n: hiveCount }] = (await sql!`select count(*)::int as n from pages where vault_id = ${space.id}`) as unknown as [{ n: number }];
    expect(hiveCount).toBe(1);

    const curator = new Curator(sql!, pages!);
    const open = await curator.list([space.id]);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "conflict", predicate: "referente tecnico", pageId: h.id, status: "open" });

    // idempotent: the same claims give no new version and no new item
    const r2 = await promoteSpace(sql!, pages!, space.id);
    expect(r2).toMatchObject({ written: 0, unchanged: 1 });
    expect((await hivePage(space.id))!.version).toBe(h.version);
    expect(await curator.list([space.id])).toHaveLength(1);

    // the curator chooses a value: the page shows it at once, without the conflict block
    await expect(curator.resolve(open[0]!.id, { choice: "nessuno" }, curatorId)).rejects.toThrow(/non è tra/);
    await curator.resolve(open[0]!.id, { choice: "nome cognomeaaa" }, curatorId);
    let hb = (await hivePage(space.id))!.body;
    expect(hb).toContain(`- Referente tecnico: [[Nome CognomeAAA]] ^[${pa.page.id}#stato-attuale] · deciso da un curatore`);
    expect(hb).not.toContain("[!conflict]");
    // the decision holds at the next promotion
    await promoteSpace(sql!, pages!, space.id);
    expect((await hivePage(space.id))!.body).toContain("deciso da un curatore");

    // a new value in a cell: the old decision does not apply, a new conflict opens
    await pages!.upsert({ vaultId: b.id, id: pb.page.id, markdown: page(`Acme ${run}`, ["Postazioni: 300", "Referente tecnico: [[Nome CognomeAAA]]", "Ha chiesto una revisione della sicurezza"]) });
    await promoteSpace(sql!, pages!, space.id);
    hb = (await hivePage(space.id))!.body;
    expect(hb).toContain(`- Referente tecnico: [[Nome CognomeAAA]] ^[${pa.page.id}#stato-attuale] ^[${pb.page.id}#stato-attuale] · 2 fonti concordi`);
    expect(hb).toContain("> [!conflict] Postazioni");
    expect((await curator.list([space.id])).map((i) => i.predicate)).toEqual(["postazioni"]);

    // retraction: the cell removes the renewal date, the hive loses it
    await pages!.upsert({ vaultId: a.id, id: pa.page.id, markdown: page(acme, ["Usa [[Company example 2]] con **250 postazioni**", "Referente tecnico: [[Nome CognomeAAA]]"], `aliases: [Acme ${run}]\n`) });
    await promoteSpace(sql!, pages!, space.id);
    hb = (await hivePage(space.id))!.body;
    expect(hb).not.toContain("Rinnovo");
    const [{ status }] = (await sql!`select status from claims where page_id = ${pa.page.id} and predicate = 'rinnovo'`) as unknown as [{ status: string }];
    expect(status).toBe("retracted");

    // the curator keeps both values (two sites): no conflict, both listed
    const [postazioni] = await curator.list([space.id]);
    await curator.dismiss(postazioni!.id, curatorId, "due sedi");
    hb = (await hivePage(space.id))!.body;
    expect(hb).toMatch(/- Postazioni: 250 \^\[[^\]]+\] · 300 \^\[[^\]]+\]/);

    // both cells delete their pages: the hive page goes too
    await pages!.delete(pa.page.id);
    await pages!.delete(pb.page.id);
    const r3 = await promoteSpace(sql!, pages!, space.id);
    expect(r3.removed).toBe(1);
    expect(await hivePage(space.id)).toBeUndefined();
  });

  db()("many hive pages going at once wait for a curator; confirmed, they go", async () => {
    const cell = await vaults!.create({ kind: "cell", slug: `hcm-${run}`, name: "Cella M" });
    const space = await vaults!.create({ kind: "space", slug: `hsm-${run}`, name: "M" });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await pages!.upsert({ vaultId: cell.id, markdown: page(`Ditta ${i} ${run}`, [`Sede: città ${i}`]) })).page.id);
    await setFeeds(sql!, space.id, [{ cellId: cell.id }]);
    expect(await promoteSpace(sql!, pages!, space.id)).toMatchObject({ written: 8 });

    // the cell loses 7 pages of 8 (e.g. emptied by mistake): nothing is removed yet
    for (const id of ids.slice(1)) await pages!.delete(id);
    const r = await promoteSpace(sql!, pages!, space.id);
    expect(r).toMatchObject({ removed: 0, held: 7 });
    const [{ n }] = (await sql!`select count(*)::int as n from pages where vault_id = ${space.id}`) as unknown as [{ n: number }];
    expect(n).toBe(8);
    const curator = new Curator(sql!, pages!);
    const [item] = await curator.list([space.id], { kind: "mass_change" });
    expect(item).toMatchObject({ subject: "Rimozione di 7 pagine dell'alveare su 8", data: { action: "remove", total: 8 } });
    expect((item!.data.subjects as string[]).length).toBe(7);
    // the next night asks nothing new
    await promoteSpace(sql!, pages!, space.id);
    expect(await curator.list([space.id], { kind: "mass_change" })).toHaveLength(1);
    // one page comes back: the old request is out of date, a new one replaces it
    const back = await pages!.upsert({ vaultId: cell.id, markdown: page(`Ditta 1 ${run}`, ["Sede: città 1"]) });
    expect(await promoteSpace(sql!, pages!, space.id)).toMatchObject({ held: 6 });
    const open = await curator.list([space.id], { kind: "mass_change" });
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(item!.id);
    expect((await curator.get(item!.id))!.status).toBe("superseded");

    await curator.resolve(open[0]!.id, { done: true }, curatorId);
    const left = await sql!<{ title: string }[]>`select title from pages where vault_id = ${space.id} order by title`;
    expect(left.map((p) => p.title)).toEqual([`Ditta 0 ${run}`, `Ditta 1 ${run}`]);
    expect(back.page.id).toBeTruthy();
  });

  db()("classification of the hive page is the highest of its sources; low confidence is queued", async () => {
    const a = await vaults!.create({ kind: "cell", slug: `hcc-${run}`, name: "C" });
    const b = await vaults!.create({ kind: "cell", slug: `hcd-${run}`, name: "D" });
    const space = await vaults!.create({ kind: "space", slug: `hsq-${run}`, name: "S" });
    await pages!.upsert({ vaultId: a.id, markdown: page(`Zeta ${run}`, ["Prezzo: 31 euro"], "classification: riservato\n") });
    await pages!.upsert({ vaultId: b.id, markdown: page(`Zeta ${run}`, ["Database: PostgreSQL"], "confidence: 0.4\n") });
    await setFeeds(sql!, space.id, [{ cellId: a.id }, { cellId: b.id }]);
    await promoteSpace(sql!, pages!, space.id);
    const h = (await hivePage(space.id))!;
    expect(h.classification).toBe(2);
    expect(h.body).toContain("- Database: PostgreSQL ^[");
    expect(h.body).toContain("· da verificare");
    const items = await new Curator(sql!, pages!).list([space.id]);
    expect(items.map((i) => i.kind)).toEqual(["low_confidence"]);
  });

  db()("claims sync only the pages changed since the last sync", async () => {
    const a = await vaults!.create({ kind: "cell", slug: `hce-${run}`, name: "E" });
    const p = await pages!.upsert({ vaultId: a.id, markdown: page(`Eta ${run}`, ["Postazioni: 10"]) });
    expect((await syncClaims(sql!, { vaultIds: [a.id] })).added).toBe(1);
    expect((await syncClaims(sql!, { vaultIds: [a.id] })).pages).toBe(0);
    await pages!.upsert({ vaultId: a.id, id: p.page.id, markdown: page(`Eta ${run}`, ["Postazioni: 12"]) });
    expect(await syncClaims(sql!, { vaultIds: [a.id] })).toMatchObject({ pages: 1, added: 1, retracted: 1 });
  });
});

describe("merge of duplicates", () => {
  db()("keeps an alias written as one string whole, not letter by letter", async () => {
    const v = await vaults!.create({ kind: "space", slug: `merge-${run}`, name: "M" });
    const keep = await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Gruppo Orsa ${run}\ntype: entity/company\n---\nCliente.` });
    const drop = await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Orsa ${run}\ntype: entity/company\naliases: Orsa Spa ${run}\n---\nFornitore.` });
    await mergePages(sql!, pages!, keep.page.id, drop.page.id);
    const [p] = await sql!<{ aliases: string[] }[]>`select frontmatter->'aliases' as aliases from pages where id = ${keep.page.id}`;
    expect([...p!.aliases].sort()).toEqual([`Orsa ${run}`, `Orsa Spa ${run}`].sort());
  });
});
