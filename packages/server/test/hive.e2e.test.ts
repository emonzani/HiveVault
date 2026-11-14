// Hive routes over HTTP: feeds (admins), curator queue (curators only), decisions, merges.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { AuthService, base32Decode, totp } from "@cb/auth";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { Curator, promoteSpace, upsertCuratorItem } from "@cb/hive";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL } from "@cb/models";
import { ulid } from "@cb/shared";
import { buildApp } from "../src/app.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: ["http://localhost"] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const curator = sql ? new Curator(sql, pages!) : undefined;
const app: FastifyInstance | undefined = sql
  ? await buildApp({
      sql,
      auth: auth!,
      vaults: vaults!,
      search: new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }),
      secureCookies: false,
      loginRateLimitPerMin: 10_000,
      hive: { curator: curator!, pages: pages! },
    })
  : undefined;
afterAll(async () => {
  await app?.close();
  await auth?.stop();
  dispatcher.stop();
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

class Client {
  cookie = "";
  csrf = "";
  call(method: string, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { cookie: this.cookie };
    if (method !== "GET") h["x-cb-csrf"] = this.csrf;
    return app!.inject({ method: method as "GET", url, headers: h, ...(payload !== undefined ? { payload: payload as string } : {}) });
  }
}
async function user(role: "admin" | "member", grants: [string, "read" | "write" | "curate"][] = []): Promise<Client> {
  const p = await auth!.principals.createUser({ username: `h${run}-${Math.random().toString(36).slice(2, 7)}`, displayName: "U", role, clearance: 3 });
  for (const [v, perm] of grants) await auth!.access.grant(p.id, v, perm, null);
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  const st = await auth!.totp.startEnrollment(code);
  const r = await auth!.enrollConfirm(code, totp(base32Decode(st.secretBase32)));
  const c = new Client();
  c.cookie = `cb_session=${r.session.token}`;
  c.csrf = r.session.csrf;
  return c;
}
const md = (t: string, lines: string[]) => `---\ntitle: ${t}\ntype: entity/company\n---\n# ${t}\n\n## Stato attuale\n${lines.map((l) => `- ${l}`).join("\n")}\n`;

describe("hive API", () => {
  db()("feeds by admins, queue and decisions by curators only, merge of duplicates", async () => {
    const c1 = await vaults!.create({ kind: "cell", slug: `hx1-${run}`, name: "C1" });
    const c2 = await vaults!.create({ kind: "cell", slug: `hx2-${run}`, name: "C2" });
    const space = await vaults!.create({ kind: "space", slug: `hxs-${run}`, name: "Clienti" });
    await pages!.upsert({ vaultId: c1.id, markdown: md(`Omega ${run}`, ["Postazioni: 10"]) });
    await pages!.upsert({ vaultId: c2.id, markdown: md(`Omega ${run}`, ["Postazioni: 12"]) });

    const admin = await user("admin");
    const cur = await user("member", [[space.id, "curate"]]);
    const reader = await user("member", [[space.id, "read"]]);

    expect((await reader.call("PUT", `/api/admin/vaults/${space.id}/feeds`, { feeds: [{ cellId: c1.id }] })).statusCode).toBe(403);
    expect((await admin.call("PUT", `/api/admin/vaults/${c1.id}/feeds`, { feeds: [{ cellId: c2.id }] })).statusCode).toBe(400);
    const f = await admin.call("PUT", `/api/admin/vaults/${space.id}/feeds`, { feeds: [{ cellId: c1.id }, { cellId: c2.id, types: ["entity"] }] });
    expect(f.statusCode).toBe(200);
    expect(f.json()).toHaveLength(2);

    await promoteSpace(sql!, pages!, space.id);
    expect((await reader.call("GET", "/api/curator")).json()).toEqual([]);
    expect((await reader.call("GET", "/api/curator/counts")).json()).toMatchObject({ total: 0, curates: false });
    const items = (await cur.call("GET", "/api/curator")).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "conflict", predicate: "postazioni", vaultName: "Clienti" });
    expect((await cur.call("GET", "/api/curator/counts")).json()).toMatchObject({ total: 1, curates: true });

    expect((await reader.call("POST", `/api/curator/${items[0].id}/resolve`, { choice: "12" })).statusCode).toBe(404);
    expect((await cur.call("POST", `/api/curator/${items[0].id}/resolve`, {})).statusCode).toBe(400);
    const ok = await cur.call("POST", `/api/curator/${items[0].id}/resolve`, { custom: "12 (contratto firmato)" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "resolved", resolution: { custom: "12 (contratto firmato)" } });
    const [h] = await sql!<{ body: string }[]>`select body from pages where vault_id = ${space.id} and frontmatter ? 'hive_subject'`;
    expect(h!.body).toContain("- Postazioni: 12 (contratto firmato) · deciso da un curatore");
    expect((await cur.call("POST", `/api/curator/${items[0].id}/resolve`, { choice: "10" })).statusCode).toBe(400);
    const [audit] = await sql!`select action from audit_log where resource = ${items[0].id}`;
    expect(audit).toMatchObject({ action: "curator.resolve" });

    // duplicate candidates in a space: the curator merges them; links to the removed page resolve to the kept one
    const x = await pages!.upsert({ vaultId: space.id, markdown: md(`Fornitore ${run}`, ["Sede: Milano"]) });
    const y = await pages!.upsert({ vaultId: space.id, markdown: md(`Fornitore ${run} Srl`, ["Sede: Milano"]) });
    const z = await pages!.upsert({ vaultId: space.id, markdown: `---\ntitle: Nota ${run}\n---\nVedi [[Fornitore ${run} Srl]].` });
    const dup = await upsertCuratorItem(sql!, space.id, "duplicate", `dup-${run}`, `Fornitore ${run}`, null, { a: { id: x.page.id, title: x.page.title }, b: { id: y.page.id, title: y.page.title } });
    // a second candidate with the page that the merge removes
    const dup2 = await upsertCuratorItem(sql!, space.id, "duplicate", `dup2-${run}`, `Fornitore ${run} Srl`, null, { a: { id: y.page.id, title: y.page.title }, b: { id: z.page.id, title: z.page.title } });
    expect((await cur.call("POST", `/api/curator/${dup.id}/merge`, { keep: z.page.id })).statusCode).toBe(400);
    const m = await cur.call("POST", `/api/curator/${dup.id}/merge`, { keep: x.page.id });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({ kept: x.page.id, removed: y.page.id, relinked: 1 });
    // the merge closes the other candidates of the removed page
    const [s2] = await sql!<{ status: string }[]>`select status from curator_items where id = ${dup2.id}`;
    expect(s2!.status).toBe("superseded");
    // a candidate whose page is gone: 409 and the item closes, never a 500
    const dup3 = await upsertCuratorItem(sql!, space.id, "duplicate", `dup3-${run}`, `Fornitore ${run}`, null, { a: { id: x.page.id, title: x.page.title }, b: { id: y.page.id, title: y.page.title } });
    expect((await cur.call("POST", `/api/curator/${dup3.id}/merge`, { keep: x.page.id })).statusCode).toBe(409);
    const [s3] = await sql!<{ status: string }[]>`select status from curator_items where id = ${dup3.id}`;
    expect(s3!.status).toBe("superseded");
    const [link] = await sql!<{ dst: string }[]>`select dst_page as dst from links where src_page = ${z.page.id}`;
    expect(link!.dst).toBe(x.page.id);

    // reports and indexes: readers only
    expect((await reader.call("GET", `/api/vaults/${c1.id}/index/llms`)).statusCode).toBe(403);
    const llms = await admin.call("GET", `/api/vaults/${c1.id}/index/llms`);
    expect(llms.statusCode).toBe(200);
    expect(llms.body).toContain(`Omega ${run}`);
    expect((await reader.call("GET", "/api/dream")).statusCode).toBe(200);
  });
});

describe("generated pages", () => {
  db()("hive pages: read-only for people, rectified at once by administrators", async () => {
    const c = await vaults!.create({ kind: "cell", slug: `hg1-${run}`, name: "G1" });
    const space = await vaults!.create({ kind: "space", slug: `hgs-${run}`, name: "G" });
    await pages!.upsert({ vaultId: c.id, markdown: md(`Teta ${run}`, ["Postazioni: 5"]) });
    const admin = await user("admin");
    await admin.call("PUT", `/api/admin/vaults/${space.id}/feeds`, { feeds: [{ cellId: c.id }] });
    await promoteSpace(sql!, pages!, space.id);
    const [h] = await sql!<{ id: string; version: number }[]>`select id, version from pages where vault_id = ${space.id}`;
    const member = await user("member", [[space.id, "write"]]);
    expect((await member.call("GET", `/api/pages/${h!.id}/full`)).json()).toMatchObject({ canWrite: false, generated: true, rectifiable: false });
    expect((await member.call("PUT", `/api/pages/${h!.id}`, { markdown: "# x", baseVersion: h!.version })).statusCode).toBe(409);
    expect((await member.call("DELETE", `/api/pages/${h!.id}`)).statusCode).toBe(409);
    // an administrator corrects the page now; the cited cell page and the item for the curators follow
    expect((await admin.call("GET", `/api/pages/${h!.id}/full`)).json()).toMatchObject({ canWrite: true, generated: true, rectifiable: true });
    const [cell] = await sql!<{ id: string }[]>`select id from pages where vault_id = ${c.id}`;
    const fixed = await admin.call("PUT", `/api/pages/${h!.id}`, { markdown: `---
title: Teta ${run}
hive_subject: altro
---
# Teta ${run}

- Postazioni: 6 ^[${cell!.id}]
`, baseVersion: h!.version });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().rectification).toMatchObject({ pages: [expect.objectContaining({ id: cell!.id })] });
    const [after] = await sql!<{ body: string; frontmatter: Record<string, unknown> }[]>`select body, frontmatter from pages where id = ${h!.id}`;
    expect(after!.body).toContain("Postazioni: 6");
    expect(after!.frontmatter.hive_subject).not.toBe("altro"); // the marks of the dream cycle stay
    const [item] = await sql!<{ kind: string; status: string }[]>`select kind, status from curator_items where id = ${fixed.json().rectification.itemId}`;
    expect(item).toEqual({ kind: "rectification", status: "open" });
    // the night keeps the corrected text while the item is open
    await promoteSpace(sql!, pages!, space.id);
    expect((await sql!<{ body: string }[]>`select body from pages where id = ${h!.id}`)[0]!.body).toContain("Postazioni: 6");
    expect((await sql!`select action from audit_log where resource = ${h!.id} and action = 'page.rectify'`)).toHaveLength(1);
    expect((await admin.call("DELETE", `/api/pages/${h!.id}`)).statusCode).toBe(409);
  });
});
