/**
 * Test data for the Playwright tests: one user for the flows, one fresh user per theme for
 * the login test, a space with linked pages. Run with tsx by the global setup; it prints the
 * state as JSON on stdout. `--clean <run>` deletes the data of a previous run.
 */
import { base32Decode, totp } from "@cb/auth";
import { PageStore } from "@cb/brain";
import { promoteSpace, setFeeds, upsertCuratorItem } from "@cb/hive";
import { loadServerConfig } from "../../server/src/config.ts";
import { createServices } from "../../server/src/services.ts";

const THEMES = ["chiaro", "scuro"];
const s = await createServices(loadServerConfig(), { models: false, workers: false });

async function clean(run: string) {
  for (const v of await s.sql<{ id: string }[]>`select id from vaults where slug like ${`e2e-${run}%`}`) await s.vaults.delete(v.id);
  await s.sql`delete from principals where name like ${`e2e-${run}%`}`;
}

async function user(name: string, displayName: string, role: "member" | "admin" = "member") {
  const p = await s.auth.principals.createUser({ username: name, displayName, role, clearance: 2 });
  const { code } = await s.auth.totp.createEnrollment(p.id, null);
  const st = await s.auth.totp.startEnrollment(code);
  // enrollment uses the code of this 30 s window: the first login must wait for the next one
  await s.auth.enrollConfirm(code, totp(base32Decode(st.secretBase32)), { userAgent: "e2e-seed" });
  return { id: p.id, username: name, secret: st.secretBase32 };
}

const args = process.argv.slice(2);
if (args[0] === "--clean") {
  await clean(args[1]!);
  await s.stop();
  process.exit(0);
}

const run = Date.now().toString(36);
const main = await user(`e2e-${run}`, "Nome CognomeEEE");
const login: Record<string, { username: string; secret: string }> = {};
for (const t of THEMES) login[t] = await user(`e2e-${run}-${t}`, `Prova ${t}`);
// the console and the dashboards (phase 7)
const admin = await user(`e2e-${run}-admin`, "Nome CognomeLLL", "admin");
await s.sql`update principals set notice_ack_at = now() where id = ${admin.id}`;

const space = await s.vaults.create({ kind: "space", slug: `e2e-${run}`, name: `Progetti E2E ${run}`, defaultClassification: 1 });
const cell = await s.vaults.create({ kind: "cell", slug: `e2e-${run}-cella`, name: "Cella di Nome CognomeEEE", owner: `user:${main.id}` });
await s.auth.access.grant(main.id, space.id, "write", null);
await s.sql`update principals set notice_ack_at = now() where id = ${main.id}`;

const pages = new PageStore(s.sql);
const md = (title: string, type: string, body: string, tags: string[] = []) =>
  `---\ntitle: ${title}\ntype: ${type}\ntldr: Pagina di prova ${title}.\n${tags.length ? `tags: [${tags.join(", ")}]\n` : ""}---\n# ${title}\n\n${body}`;
const alfa = await pages.upsert({
  vaultId: space.id,
  markdown: md(`Alfa ${run}`, "entity/project", `## Stato attuale\n- Il progetto collabora con [[Beta ${run}]] e usa PostgreSQL\n- Responsabile: [[Gamma ${run}]]\n\n## Timeline\n- 2026-10-01 · Avvio`),
});
const beta = await pages.upsert({
  vaultId: space.id,
  markdown: md(`Beta ${run}`, "entity/company", `## Stato attuale\n- Cliente con 120 postazioni\n- Collegato a [[Alfa ${run}]]\n\n> [!conflict] Postazioni\n> Una email parla di 150 postazioni.`, ["clienti"]),
});
await pages.upsert({ vaultId: space.id, markdown: md(`Gamma ${run}`, "entity/person", `## Stato attuale\n- Lavora su [[Alfa ${run}]]`, ["clienti", "persone"]) });
await pages.upsert({ vaultId: cell.id, markdown: md(`Appunti ${run}`, "note", `- [ ] Chiamare [[Beta ${run}]]`) });

// hive: two cells disagree on one value; the main user curates the space
const hive = await s.vaults.create({ kind: "space", slug: `e2e-${run}-alveare`, name: `Alveare ${run}` });
const other = await s.vaults.create({ kind: "cell", slug: `e2e-${run}-cella2`, name: "Cella di Nome CognomeFFF" });
await s.auth.access.grant(main.id, hive.id, "curate", null);
const company = (seats: number) => `---
title: Delta ${run}
type: entity/company
---
# Delta ${run}

## Stato attuale
- Postazioni: ${seats}
- Rinnovo: 2027-05-01
`;
await pages.upsert({ vaultId: cell.id, markdown: company(80) });
await pages.upsert({ vaultId: other.id, markdown: company(95) });
await setFeeds(s.sql, hive.id, [{ cellId: cell.id }, { cellId: other.id }]);
await promoteSpace(s.sql, pages, hive.id);
// an edit proposed by the cloud agent on a page of the main user's cell
const gammaId = (await s.sql<{ id: string; version: number; body: string }[]>`select id, version, body from pages where vault_id = ${space.id} and title = ${`Gamma ${run}`}`)[0]!;
await upsertCuratorItem(s.sql, space.id, "proposal", `prop-${run}`, `gamma ${run}`, null, {
  title: `Gamma ${run}`,
  pageId: gammaId.id,
  baseVersion: gammaId.version,
  section: "stato-attuale",
  body: gammaId.body.replace("- Lavora su", "- Responsabile tecnico da ottobre\n- Lavora su"),
  before: gammaId.body,
  rationale: "Email del 2026-10-01",
  by: "agent-test",
});
await s.sql`update curator_items set page_id = ${gammaId.id} where fingerprint = ${`prop-${run}`}`;
await s.auth.access.grant(main.id, space.id, "admin", null);
// "Da rivedere": one link with little text per theme, uploaded by the main user
for (const t of THEMES) {
  const { source } = await s.ingest.store.create(Buffer.from(`<html><body>Pagina ${t} ${run}</body></html>`), {
    vaultId: space.id,
    name: `rivedere-${t}-${run}.html`,
    origin: "link",
    path: `https://example.com/${t}/${run}`,
    createdBy: main.id,
    meta: { url: `https://example.com/${t}/${run}`, warnings: ["little_text"] },
  }, "system");
  await s.sql`update sources set status = 'indexed', level = 1, title = ${`Rivedere ${t} ${run}`} where id = ${source.id}`;
}

process.stdout.write(JSON.stringify({ run, main, admin, login, vaultId: space.id, cellId: cell.id, hiveId: hive.id, pages: { alfa: alfa.page.id, beta: beta.page.id } }));
await s.stop();
