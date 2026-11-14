import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { exportVault, importVault, obsidianFileName, PageStore, parseDocument, VaultStore } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-obs-"));
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();

describe("obsidian export / import", () => {
  it("makes file names safe for Obsidian", () => {
    expect(obsidianFileName("Progetto: Atlas/2 [beta]")).toBe("Progetto- Atlas-2 -beta-");
  });

  db()("round-trips a vault: pages, links, classification and ids", async () => {
    const vs = new VaultStore(sql!, 16);
    const ps = new PageStore(sql!, { minTokens: 1 });
    const a = await vs.create({ kind: "space", slug: `obs-a-${run}`, name: "Clienti", schemaMd: "# Schema\n\nUna pagina per cliente." });
    const acme = await ps.upsert({ vaultId: a.id, markdown: "---\ntitle: \"Alpi Sanità S.p.A.\"\ntype: entity/company\nclassification: riservato\naliases: [Alpi Sanita]\n---\nReferente [[Nome CognomeCCC]]. Progetto [[Cometa: fase 1]]." });
    await ps.upsert({ vaultId: a.id, markdown: "---\ntitle: Nome CognomeCCC\ntype: entity/person\n---\nLavora per [[Alpi Sanita]]." });
    await ps.upsert({ vaultId: a.id, markdown: "---\ntitle: \"Cometa: fase 1\"\ntype: decision\n---\nDecisione sul database." });

    const out = path.join(tmp, "export");
    const ex = await exportVault(sql!, a.id, out);
    expect(ex.pages).toBe(3);
    const top = (await readdir(out)).sort();
    expect(top).toEqual(["SCHEMA.md", "decisions", "entities", "index.md", "llms.txt"]);
    const index = await readFile(path.join(out, "index.md"), "utf8");
    expect(index).toContain("[[Cometa- fase 1|Cometa: fase 1]]");
    const acmeFile = parseDocument(await readFile(path.join(out, "entities", "Alpi Sanità S.p.A..md"), "utf8"));
    expect(acmeFile.frontmatter).toMatchObject({ id: acme.page.id, classification: "riservato" });

    // import into a new vault
    const b = await vs.create({ kind: "space", slug: `obs-b-${run}`, name: "Copia" });
    const im = await importVault(sql!, ps, b.id, out);
    expect(im).toMatchObject({ pages: 3, created: 3, unresolvedLinks: 0 });
    // vault b gets copies with new ids; the pages of vault a are untouched
    const bIds = (await sql!<{ id: string }[]>`select id from pages where vault_id = ${b.id}`).map((r) => r.id);
    expect(bIds).not.toContain(acme.page.id);
    expect((await PageStore.get(sql!, acme.page.id))!.vaultId).toBe(a.id);
    // importing the same folder again finds the copies by path: nothing changes
    const again = await importVault(sql!, ps, b.id, out);
    expect(again).toMatchObject({ pages: 3, created: 0, updated: 0, unchanged: 3 });
    // into its own vault: same ids, no new pages; the first time the path becomes the Obsidian
    // file name and the frontmatter is normalized, then the round trip is stable
    const home = await importVault(sql!, ps, a.id, out);
    expect(home).toMatchObject({ pages: 3, created: 0 });
    expect((await PageStore.get(sql!, acme.page.id))!.path).toBe("entities/Alpi Sanità S.p.A..md");
    await exportVault(sql!, a.id, out);
    expect(await importVault(sql!, ps, a.id, out)).toMatchObject({ pages: 3, created: 0, updated: 0, unchanged: 3 });
    expect(await importVault(sql!, ps, a.id, out)).toMatchObject({ unchanged: 3 });
    const [schema] = await sql!`select schema_md from vaults where id = ${b.id}`;
    expect((schema as { schema_md: string }).schema_md).toContain("Una pagina per cliente.");
  });

  db()("imports a plain Obsidian folder without frontmatter", async () => {
    const dir = path.join(tmp, "plain");
    await mkdir(path.join(dir, "Persone"), { recursive: true });
    await writeFile(path.join(dir, "Persone", "Nome CognomeBBB.md"), "Project manager di [[Progetto Aurora]].\n");
    await writeFile(path.join(dir, "Progetto Aurora.md"), "# Progetto Aurora\n\nGuidato da [[Nome CognomeBBB]].\n");
    await mkdir(path.join(dir, ".obsidian"), { recursive: true });
    await writeFile(path.join(dir, ".obsidian", "app.json"), "{}");
    const v = await new VaultStore(sql!, 16).create({ kind: "cell", slug: `obs-plain-${run}`, name: "Note" });
    const r = await importVault(sql!, new PageStore(sql!), v.id, dir);
    expect(r).toMatchObject({ pages: 2, created: 2, unresolvedLinks: 0 });
  });
});
