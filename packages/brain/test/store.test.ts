import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { PageStore, VaultStore, version, versions, withReader, type Principal } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
afterAll(async () => {
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();
const vaults = () => new VaultStore(sql!, 16);
const pages = () => new PageStore(sql!, { minTokens: 1 });

async function newVault(name: string, kind: "cell" | "space" = "space") {
  return vaults().create({ kind, slug: `${name}-${run}`, name });
}

describe("VaultStore", () => {
  db()("creates a vault with its own chunk partition and vector index", async () => {
    const v = await newVault("clienti");
    const [part] = await sql!`select relname from pg_class where relname = ${v.chunksPartition}`;
    expect(part).toBeTruthy();
    const [idx] = await sql!`select indexdef from pg_indexes where tablename = ${v.chunksPartition} and indexname like '%vec_idx'`;
    expect((idx as { indexdef: string }).indexdef).toMatch(/binary_quantize/);
  });

  db()("rejects unsafe slugs", async () => {
    await expect(vaults().create({ kind: "space", slug: "x'; drop table pages;--", name: "x" })).rejects.toThrow(/invalid vault slug/);
  });
});

describe("PageStore", () => {
  db()("writes a page with aliases, blocks, links and chunks, and bumps the vault version", async () => {
    const v = await newVault("wiki");
    const r = await pages().upsert({
      vaultId: v.id,
      markdown: `---\ntitle: Alpi Sanità S.p.A.\ntype: entity/company\naliases: [Alpi Sanita]\nclassification: interno\n---\n\nCliente dal 2025. Referente [[Nome CognomeCCC]].\n\n## Stato attuale\n- 250 postazioni ^[src_1#c2]\n\n## Timeline\n- 2025-05-31 · Firma`,
    });
    expect(r.created).toBe(true);
    expect(r.page.id).toMatch(/^ent_/);
    expect(r.page.path).toBe("entities/alpi-sanita-s-p-a.md");
    expect(r.page.tldr).toBe("Cliente dal 2025. Referente Nome CognomeCCC.");
    expect(r.chunks).toBeGreaterThan(0);
    const blocks = await sql!`select block_id from blocks where page_id = ${r.page.id} order by start_offset`;
    expect(blocks.map((b) => b.block_id)).toEqual(["intro", "stato-attuale", "timeline"]);
    const [{ version }] = (await sql!`select version from vaults where id = ${v.id}`) as unknown as [{ version: number }];
    expect(Number(version)).toBe(1);
    const found = await PageStore.resolve(sql!, [v.id], "alpi sanita");
    expect(found.map((p) => p.id)).toEqual([r.page.id]);
  });

  db()("resolves links that were waiting for a page created later", async () => {
    const v = await newVault("links");
    const a = await pages().upsert({ vaultId: v.id, markdown: "# Progetto Cometa\n\nPM: [[Nome CognomeBBB]], cliente [[Alpi Sanità]]." });
    let out = await PageStore.outlinks(sql!, a.page.id);
    expect(out.map((l) => l.id)).toEqual([null, null]);
    const b = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Nome CognomeBBB\ntype: entity/person\n---\nProject manager." });
    expect(b.linksResolved).toBe(1);
    out = await PageStore.outlinks(sql!, a.page.id);
    expect(out[0]!.id).toBe(b.page.id);
    expect((await PageStore.backlinks(sql!, b.page.id)).map((x) => x.id)).toEqual([a.page.id]);
    // deleting the target makes the link wait again
    await pages().delete(b.page.id);
    out = await PageStore.outlinks(sql!, a.page.id);
    expect(out[0]!.id).toBeNull();
  });

  db()("a page that drops an alias lets the links on that name go, to the page that has it now", async () => {
    const v = await newVault("alias");
    const big = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Norma 1\ntype: concept\naliases: [Norma 2]\n---\nParti 1 e 2." });
    const ref = await pages().upsert({ vaultId: v.id, markdown: "# Nota\n\nVedi [[Norma 2]] e [[Norma 1]]." });
    expect((await PageStore.outlinks(sql!, ref.page.id)).map((l) => l.id)).toEqual([big.page.id, big.page.id]);
    // the alias goes: the link on it waits, the link on the title stays
    await pages().upsert({ vaultId: v.id, id: big.page.id, markdown: "---\ntitle: Norma 1\ntype: concept\n---\nParte 1." });
    expect((await PageStore.outlinks(sql!, ref.page.id)).map((l) => l.id)).toEqual([null, big.page.id]);
    // a new page with that name takes the link
    const two = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Norma 2\ntype: concept\n---\nParte 2." });
    expect(two.linksResolved).toBe(1);
    expect((await PageStore.outlinks(sql!, ref.page.id)).map((l) => l.id)).toEqual([two.page.id, big.page.id]);
  });

  db()("a link goes to the document by its code, and to the compiled page when one has the same name", async () => {
    const v = await newVault("codes");
    const ref = await pages().upsert({ vaultId: v.id, markdown: "# Nota\n\nVedi [[ETSI EN 319 522-2]]." });
    const doc = await pages().upsert({
      vaultId: v.id,
      markdown: "---\ntitle: EN 319 522-2 - V1.2.1 - Semantic contents\ntype: source\naliases: [EN 319 522-2, ETSI EN 319 522-2]\n---\nTesto.",
    });
    expect(doc.linksResolved).toBe(1);
    expect((await PageStore.outlinks(sql!, ref.page.id)).map((l) => l.id)).toEqual([doc.page.id]);
    // a concept page on the same name takes the link, also written after the document
    const cpt = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: ETSI EN 319 522-2\ntype: concept\n---\nLa parte 2." });
    expect((await PageStore.outlinks(sql!, ref.page.id)).map((l) => l.id)).toEqual([cpt.page.id]);
    const later = await pages().upsert({ vaultId: v.id, markdown: "# Altra nota\n\nAnche [[EN 319 522-2]]." });
    expect((await PageStore.outlinks(sql!, later.page.id)).map((l) => l.id)).toEqual([doc.page.id]);
    expect((await PageStore.resolve(sql!, [v.id], "ETSI EN 319 522-2")).map((p) => p.id)).toEqual([cpt.page.id, doc.page.id]);
    // the concept page goes: its links fall back to the document
    await pages().delete(cpt.page.id);
    expect((await PageStore.outlinks(sql!, ref.page.id)).map((l) => l.id)).toEqual([doc.page.id]);
    // a second document with the same code: old and new links stay on the first one
    const v2 = await pages().upsert({
      vaultId: v.id,
      markdown: "---\ntitle: EN 319 522-2 - V1.3.1 - Semantic contents\ntype: source\naliases: [EN 319 522-2, ETSI EN 319 522-2]\n---\nTesto nuovo.",
    });
    const newer = await pages().upsert({ vaultId: v.id, markdown: "# Terza nota\n\nPoi [[ETSI EN 319 522-2]]." });
    expect((await PageStore.outlinks(sql!, newer.page.id)).map((l) => l.id)).toEqual([doc.page.id]);
    expect((await PageStore.resolve(sql!, [v.id], "EN 319 522-2")).map((p) => p.id)).toEqual([doc.page.id, v2.page.id]);
  });

  db()("keeps versions, skips unchanged writes, and keeps embeddings of unchanged chunks", async () => {
    const v = await newVault("versions");
    const body1 = "## A\n\nParagrafo che non cambia mai.\n\n## B\n\nParagrafo che cambierà.";
    const r1 = await pages().upsert({ vaultId: v.id, frontmatter: { title: "Nota" }, body: body1 });
    // simulate the indexer: give every chunk an embedding
    await sql!`update chunks set embedding = ${`[${Array(16).fill(0.25).join(",")}]`}::halfvec, embedding_model = 'm'
               where vault_id = ${v.id} and page_id = ${r1.page.id}`;
    const same = await pages().upsert({ vaultId: v.id, frontmatter: { title: "Nota" }, body: body1 });
    expect(same.changed).toBe(false);
    const r2 = await pages().upsert({ vaultId: v.id, frontmatter: { title: "Nota" }, body: body1.replace("cambierà", "è cambiato") });
    expect(r2.page.version).toBe(2);
    expect((await PageStore.versions(sql!, r1.page.id)).map((x) => x.version)).toEqual([1]);
    const chunks = await sql!<{ block_id: string; has: boolean }[]>`
      select block_id, embedding is not null as has from chunks where vault_id = ${v.id} and page_id = ${r1.page.id} order by ord`;
    expect(chunks).toEqual([
      { block_id: "a", has: true },
      { block_id: "b", has: false },
    ]);
  });
});

describe("Row Level Security (reader role)", () => {
  db()("a reader sees only its vaults and its clearance, even without a filter", async () => {
    const a = await newVault("rls-a");
    const b = await newVault("rls-b");
    const pa = await pages().upsert({ vaultId: a.id, markdown: "---\ntitle: Pagina A\nclassification: interno\n---\nTesto A segreto per B." });
    const ps = await pages().upsert({ vaultId: a.id, markdown: "---\ntitle: Pagina riservata\nclassification: riservato\n---\nStipendi." });
    const pb = await pages().upsert({ vaultId: b.id, markdown: "---\ntitle: Pagina B\n---\nTesto B." });
    const reader: Principal = { id: "user:test", vaults: [a.id], clearance: 1 };

    const seen = await withReader(sql!, reader, async (tx) => ({
      pages: (await tx<{ id: string }[]>`select id from pages`).map((r) => r.id),
      chunks: (await tx<{ page_id: string }[]>`select distinct page_id from chunks`).map((r) => r.page_id),
      vaults: (await tx<{ id: string }[]>`select id from vaults`).map((r) => r.id),
      other: await PageStore.get(tx, pb.page.id),
    }));
    expect(seen.pages).toEqual([pa.page.id]);
    expect(seen.chunks).toEqual([pa.page.id]);
    expect(seen.vaults).toEqual([a.id]);
    expect(seen.other).toBeUndefined();
    expect(seen.pages).not.toContain(ps.page.id);

    // the partition of vault B cannot be read directly
    await expect(withReader(sql!, reader, (tx) => tx.unsafe(`select * from ${b.chunksPartition}`))).rejects.toThrow(/permission denied/);
    // the reader cannot write
    await expect(withReader(sql!, reader, (tx) => tx`update pages set title = 'x' where id = ${pa.page.id}`)).rejects.toThrow(/permission denied/);
    // a principal with clearance 2 sees the riservato page
    const hr = await withReader(sql!, { ...reader, clearance: 2 }, (tx) => tx<{ id: string }[]>`select id from pages order by title`);
    expect(hr.map((r) => r.id).sort()).toEqual([pa.page.id, ps.page.id].sort());
  });

  db()("an earlier version keeps its classification when the page is lowered", async () => {
    const v = await newVault("rls-versions");
    const r1 = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Gara\nclassification: segreto\n---\nOfferta: 1.234.000 euro." });
    const r2 = await pages().upsert({ vaultId: v.id, id: r1.page.id, markdown: "---\ntitle: Gara\nclassification: interno\n---\nOfferta inviata." });
    expect(r2.page.version).toBe(2);
    const [stored] = await sql!<{ classification: number }[]>`select classification from page_versions where page_id = ${r1.page.id} and version = 1`;
    expect(stored!.classification).toBe(3);

    const low: Principal = { id: "user:low", vaults: [v.id], clearance: 1 };
    expect((await versions(sql!, low, r1.page.id))!.map((x) => x.version)).toEqual([2]);
    expect(await version(sql!, low, r1.page.id, 1)).toBeUndefined();
    expect(await withReader(sql!, low, (tx) => tx`select 1 from page_versions where page_id = ${r1.page.id}`)).toHaveLength(0);

    const high: Principal = { ...low, id: "user:high", clearance: 3 };
    expect((await versions(sql!, high, r1.page.id))!.map((x) => x.version)).toEqual([2, 1]);
    expect((await version(sql!, high, r1.page.id, 1))!.body).toContain("1.234.000");
  });

  db()("an earlier personale version stays with the owner when the page is lowered", async () => {
    const owner = `user:own-${run}`;
    const v = await vaults().create({ kind: "cell", slug: `rls-pers-${run}`, name: "Personale", owner, defaultClassification: 4 });
    const r1 = await pages().upsert({ vaultId: v.id, markdown: "# Diario\n\nVisita medica martedì." });
    expect(r1.page.classification).toBe(4);
    await pages().upsert({ vaultId: v.id, id: r1.page.id, markdown: "---\ntitle: Diario\nclassification: interno\n---\nNota condivisa." });

    const me: Principal = { id: owner, vaults: [v.id], clearance: 1, personal: [v.id] };
    expect((await versions(sql!, me, r1.page.id))!.map((x) => x.version)).toEqual([2, 1]);
    expect((await version(sql!, me, r1.page.id, 1))!.body).toContain("Visita medica");

    // an administrator (clearance 3, every vault) sees the page, not its personale history
    const admin: Principal = { id: "user:admin", vaults: [v.id], clearance: 3 };
    expect((await versions(sql!, admin, r1.page.id))!.map((x) => x.version)).toEqual([2]);
    expect(await version(sql!, admin, r1.page.id, 1)).toBeUndefined();
  });

  db()("a version written without a classification by an older release gets the classification of its page", async () => {
    const v = await newVault("rls-legacy");
    const owner = `user:leg-${run}`;
    const pv = await vaults().create({ kind: "cell", slug: `rls-legacy-pers-${run}`, name: "Personale", owner, defaultClassification: 4 });
    const pi = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Interna\nclassification: interno\n---\nTesto." });
    const pr = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Riservata\nclassification: riservato\n---\nTesto." });
    const pp = await pages().upsert({ vaultId: pv.id, markdown: "# Privata\n\nTesto." });
    // the insert of a release before 017: no classification, the page row gets updated afterwards.
    // The trigger of 017 gives the version the classification of its page.
    for (const p of [pi.page, pr.page, pp.page]) {
      await sql!`insert into page_versions (page_id, version, title, body, frontmatter, hash, author)
                 values (${p.id}, ${p.version}, ${p.title}, ${"Vecchio testo."}, ${sql!.json({})}, ${p.hash}, ${null})`;
      await sql!`update pages set version = version + 1 where id = ${p.id}`;
    }
    const stored = await sql!<{ id: string; classification: number }[]>`
      select page_id as id, classification from page_versions where page_id in ${sql!([pi.page.id, pr.page.id, pp.page.id])}`;
    expect(Object.fromEntries(stored.map((r) => [r.id, r.classification]))).toEqual({ [pi.page.id]: 1, [pr.page.id]: 2, [pp.page.id]: 4 });

    // exactly the readers of the page see the version
    const seen = (p: Principal) =>
      withReader(sql!, p, async (tx) => (await tx<{ id: string }[]>`select page_id as id from page_versions where page_id in ${tx([pi.page.id, pr.page.id, pp.page.id])}`).map((r) => r.id).sort());
    const pagesSeen = (p: Principal) =>
      withReader(sql!, p, async (tx) => (await tx<{ id: string }[]>`select id from pages where id in ${tx([pi.page.id, pr.page.id, pp.page.id])}`).map((r) => r.id).sort());
    const readers: Principal[] = [
      { id: "user:c1", vaults: [v.id, pv.id], clearance: 1 },
      { id: "user:c3", vaults: [v.id, pv.id], clearance: 3 },
      { id: owner, vaults: [v.id, pv.id], clearance: 1, personal: [pv.id] },
    ];
    for (const r of readers) expect(await seen(r)).toEqual(await pagesSeen(r));
    expect(await seen(readers[0]!)).toEqual([pi.page.id]);
    expect(await seen(readers[1]!)).toEqual([pi.page.id, pr.page.id].sort());
    expect(await seen(readers[2]!)).toEqual([pi.page.id, pp.page.id].sort());
  });

  db()("a version written before migration 017 (no classification) follows its page, also after the page is lowered", async () => {
    const v = await newVault("rls-null");
    const r1 = await pages().upsert({ vaultId: v.id, markdown: "---\ntitle: Gara\nclassification: segreto\n---\nOfferta: 1.234.000 euro." });
    const id = r1.page.id;
    // a row as migration 017 found it: written by the owner role with the trigger and the constraint
    // switched off, in one transaction, so that they are back however the test ends
    await sql!.begin(async (tx) => {
      await tx`alter table page_versions disable trigger page_versions_classification_trg`;
      await tx`alter table page_versions drop constraint page_versions_classification_set`;
      await tx`insert into page_versions (page_id, version, title, body, frontmatter, hash, author)
               values (${id}, ${r1.page.version}, ${r1.page.title}, ${"Vecchio testo."}, ${tx.json({})}, ${r1.page.hash}, ${null})`;
      await tx`alter table page_versions add constraint page_versions_classification_set check (classification is not null) not valid`;
      await tx`alter table page_versions enable trigger page_versions_classification_trg`;
      await tx`update pages set version = version + 1 where id = ${id}`;
    });
    const [stored] = await sql!<{ classification: number | null }[]>`select classification from page_versions where page_id = ${id} and version = 1`;
    expect(stored!.classification).toBeNull();

    const low: Principal = { id: "user:low", vaults: [v.id], clearance: 1 };
    const high: Principal = { ...low, id: "user:high", clearance: 3 };
    expect(await versions(sql!, low, id)).toBeUndefined();
    expect((await versions(sql!, high, id))!.map((x) => x.version)).toEqual([2, 1]);

    // lowered: version 2 keeps segreto, the version without a classification follows the page
    const r3 = await pages().upsert({ vaultId: v.id, id, markdown: "---\ntitle: Gara\nclassification: interno\n---\nOfferta inviata." });
    expect(r3.page.version).toBe(3);
    expect((await versions(sql!, low, id))!.map((x) => x.version)).toEqual([3, 1]);
    expect((await version(sql!, low, id, 1))!.body).toBe("Vecchio testo.");
    expect(await version(sql!, low, id, 2)).toBeUndefined();
    expect((await versions(sql!, high, id))!.map((x) => x.version)).toEqual([3, 2, 1]);
  });

  db()("search operators are leakproof, so the reader can use the GIN and trigram indexes", async () => {
    const rows = await sql!<{ proname: string; proleakproof: boolean }[]>`
      select proname, proleakproof from pg_proc where proname in ('ts_match_vq', 'similarity_op') order by proname`;
    expect(rows.map((r) => [r.proname, r.proleakproof])).toEqual([
      ["similarity_op", true],
      ["ts_match_vq", true],
    ]);
  });

  db()("rejects vault ids that could inject into the setting", async () => {
    await expect(withReader(sql!, { id: "x", vaults: ["a},{b"], clearance: 1 }, async () => 1)).rejects.toThrow(/invalid vault id/);
  });
});
