// Links during the day (M1): minutes after a page is written, its mentions are linked and its
// subject is in the hive, without the dream cycle.
import { afterAll, describe, expect, it } from "vitest";
import { PageStore, PageVersionError, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { defineLinkTask, setFeeds } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const db = () => (sql ? it : it.skip);
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const vaults = sql ? new VaultStore(sql, 16) : undefined;
let engine: TaskEngine | undefined;
afterAll(async () => {
  await engine?.stop();
  await sql?.end();
});

const until = async <T>(f: () => Promise<T | undefined | null | false>, what: string): Promise<T> => {
  for (let i = 0; i < 300; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${what}`);
};

describe("links during the day", () => {
  db()("a write with an old version keeps the newer text", async () => {
    const cell = await vaults!.create({ kind: "cell", slug: `lv-${run}`, name: "Versioni" });
    const a = await pages!.upsert({ vaultId: cell.id, markdown: `---\ntitle: Nota ${run}\n---\nPrima versione.\n` });
    await pages!.upsert({ vaultId: cell.id, id: a.page.id, markdown: `---\ntitle: Nota ${run}\n---\nSeconda versione.\n` });
    await expect(pages!.upsert({ vaultId: cell.id, id: a.page.id, markdown: `---\ntitle: Nota ${run}\n---\nTesto vecchio con un link.\n`, ifVersion: a.page.version })).rejects.toBeInstanceOf(
      PageVersionError,
    );
    const [p] = await sql!<{ body: string }[]>`select body from pages where id = ${a.page.id}`;
    expect(p!.body).toContain("Seconda versione.");
  });

  db()("links the mentions and promotes the subject of the pages written since the last pass", { timeout: 60_000 }, async () => {
    const cell = await vaults!.create({ kind: "cell", slug: `lc-${run}`, name: "Cella" });
    const space = await vaults!.create({ kind: "space", slug: `ls-${run}`, name: "Alveare" });
    await setFeeds(sql!, space.id, [{ cellId: cell.id }]);
    // a page written before the first pass: it gets the link when the name it writes is new
    const old = await pages!.upsert({ vaultId: cell.id, markdown: `---\ntitle: Vecchia ${run}\ntype: note\n---\nNota scritta prima: Gamma ${run} S.r.l. non è collegata.\n` });

    const task = defineLinkTask({ sql: sql!, pages: pages!, intervalMs: 100, name: `links-${run}`, vaultIds: [cell.id, space.id] });
    engine = new TaskEngine(sql!, { pollMs: 50 }).register(task);
    await engine.start();
    const { id } = await engine.submit(task, {}, { requestId: `links-${run}` });
    await until(async () => (await sql!<{ s: { started: string | null } }[]>`select state as s from tasks where id = ${id}`)[0]?.s.started, "first pass");

    await pages!.upsert({ vaultId: cell.id, markdown: `---\ntitle: Gamma ${run} S.r.l.\ntype: entity/company\n---\n# Gamma ${run} S.r.l.\n\n## Stato attuale\n- Postazioni: 40\n` });
    const note = await pages!.upsert({ vaultId: cell.id, markdown: `---\ntitle: Verbale ${run}\ntype: note\n---\nRiunione con Gamma ${run} S.r.l. sul rinnovo.\n` });

    const body = await until(async () => {
      const [p] = await sql!<{ body: string }[]>`select body from pages where id = ${note.page.id}`;
      return p!.body.includes("[[") && p!.body;
    }, "crosslink");
    expect(body).toContain(`Riunione con [[Gamma ${run} S.r.l.]] sul rinnovo.`);

    const hive = await until(async () => {
      const [h] = await sql!<{ body: string }[]>`select body from pages where vault_id = ${space.id} and frontmatter ? 'hive_subject'`;
      return h;
    }, "promotion");
    expect(hive.body).toContain("40");

    const [o] = await sql!<{ body: string }[]>`select body from pages where id = ${old.page.id}`;
    expect(o!.body).toContain(`[[Gamma ${run} S.r.l.]]`);
  });
});
