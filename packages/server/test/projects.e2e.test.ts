// Project documentation written by coding agents: an API account with the scope "projects"
// creates the vault of a project, writes its six sections with an optimistic version check,
// and can do nothing else.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AuthService } from "@cb/auth";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
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
const app = sql
  ? await buildApp({ sql, auth: auth!, vaults: vaults!, search: new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }), secureCookies: false, loginRateLimitPerMin: 10_000 })
  : undefined;
afterAll(async () => {
  await app?.close();
  await auth?.stop();
  dispatcher.stop();
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

async function key(scopes: ("projects" | "read" | "write")[]) {
  const p = await auth!.principals.createApiAccount({ name: `proj-${run}-${Math.random().toString(36).slice(2, 6)}`, scopes, clearance: 1 });
  const { key: k } = await auth!.apiKeys.issue(p.id);
  const call = (method: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
    app!.inject({ method, url, headers: { authorization: `Bearer ${k}` }, ...(body ? { payload: body as object } : {}) });
  return { id: p.id, call };
}

describe("project documentation", () => {
  db()("creates the vault, writes and reads the sections, refuses a stale write", async () => {
    const agent = await key(["projects"]);
    const slug = `prog-${run}`;
    const created = await agent.call("POST", "/api/projects", { slug, name: `Progetto ${run}` });
    expect(created.statusCode, created.body).toBe(201);
    expect((await agent.call("POST", "/api/projects", { slug, name: "altro" })).json()).toMatchObject({ created: false });
    const [v] = await sql!<{ owner: string; kind: string }[]>`select owner, kind from vaults where slug = ${slug}`;
    expect(v).toEqual({ owner: `project:${slug}`, kind: "cell" });

    // the agent's own grant is read at the next request
    const empty = (await agent.call("GET", `/api/projects/${slug}`)).json();
    expect(empty.sections).toHaveLength(6);
    expect(empty.sections.every((s: { missing?: boolean }) => s.missing)).toBe(true);
    expect((await agent.call("GET", `/api/projects/${slug}/docs/specifiche`)).statusCode).toBe(404);

    const w1 = await agent.call("PUT", `/api/projects/${slug}/docs/specifiche`, { markdown: "---\ntitle: X\nhive_subject: falso\n---\n## Requisiti\n- R1: login TOTP\n", summary: "Requisiti del progetto." });
    expect(w1.statusCode, w1.body).toBe(200);
    expect(w1.json()).toMatchObject({ version: 1, changed: true });
    const doc = (await agent.call("GET", `/api/projects/${slug}/docs/specifiche`)).json();
    expect(doc.markdown).toContain("R1: login TOTP");
    // the frontmatter is the server's: no mark of the dream cycle gets in
    const page = (await PageStore.resolve(sql!, [created.json().id], `Specifiche · Progetto ${run}`))[0]!;
    expect(page.path).toBe("progetto/specifiche.md");
    expect(page.frontmatter).toMatchObject({ project_section: "specifiche", type: "synthesis/progetto" });
    expect(page.frontmatter).not.toHaveProperty("hive_subject");
    expect(page.tldr).toBe("Requisiti del progetto.");

    // a write without the version read, or on an older one, is refused
    expect((await agent.call("PUT", `/api/projects/${slug}/docs/specifiche`, { markdown: "x", summary: "x" })).statusCode).toBe(409);
    const w2 = await agent.call("PUT", `/api/projects/${slug}/docs/specifiche`, { markdown: "## Requisiti\n- R1\n- R2\n", summary: "Due requisiti.", baseVersion: 1 });
    expect(w2.json()).toMatchObject({ version: 2 });
    expect((await agent.call("PUT", `/api/projects/${slug}/docs/specifiche`, { markdown: "y", summary: "y", baseVersion: 1 })).statusCode).toBe(409);
    expect((await agent.call("PUT", `/api/projects/${slug}/docs/ricette`, { markdown: "y", summary: "y" })).statusCode).toBe(404);

    const list = (await agent.call("GET", `/api/projects/${slug}`)).json();
    expect(list.sections.find((s: { section: string }) => s.section === "specifiche")).toMatchObject({ version: 2, tldr: "Due requisiti." });
    const [audit] = await sql!`select data from audit_log where action = 'project.doc.write' and principal_id = ${agent.id} order by id desc limit 1`;
    expect(audit!.data).toMatchObject({ section: "specifiche", version: 2 });
  });

  db()("keeps the commit a section describes until a write without one", async () => {
    const agent = await key(["projects"]);
    const slug = `prog3-${run}`;
    await agent.call("POST", "/api/projects", { slug, name: "P3" });
    const url = `/api/projects/${slug}/docs/indice-codice`;
    expect((await agent.call("PUT", url, { markdown: "x", summary: "x", commit: "not-a-sha" })).statusCode).toBe(400);
    expect((await agent.call("PUT", url, { markdown: "## A\n", summary: "A.", commit: "5906a70edaa13b65" })).statusCode).toBe(200);
    expect((await agent.call("GET", url)).json()).toMatchObject({ version: 1, commit: "5906a70edaa13b65" });
    const list = (await agent.call("GET", `/api/projects/${slug}`)).json();
    expect(list.sections.find((s: { section: string }) => s.section === "indice-codice")).toMatchObject({ commit: "5906a70edaa13b65" });
    // a write that does not say which commit it describes no longer claims the old one
    await agent.call("PUT", url, { markdown: "## B\n", summary: "B.", baseVersion: 1 });
    expect((await agent.call("GET", url)).json()).not.toHaveProperty("commit");
  });

  db()("the scope does nothing else; other accounts and other vaults are refused", async () => {
    const agent = await key(["projects"]);
    const slug = `prog2-${run}`;
    const v = (await agent.call("POST", "/api/projects", { slug, name: "P2" })).json();
    // no reading routes, no editor (MCP and sources check the same scopes)
    expect((await agent.call("GET", "/api/recent")).statusCode).toBe(403);
    expect((await agent.call("POST", `/api/vaults/${v.id}/pages`, { title: "Altro" })).statusCode).toBe(403);
    // an account without the scope cannot use the routes
    const reader = await key(["read"]);
    expect((await reader.call("GET", `/api/projects/${slug}`)).statusCode).toBe(403);
    // a vault that is not a project, or a project of another account
    const other = await vaults!.create({ kind: "cell", slug: `notproj-${run}`, name: "N" });
    expect((await agent.call("POST", "/api/projects", { slug: other.slug, name: "N" })).statusCode).toBe(409);
    expect((await agent.call("GET", `/api/projects/${other.slug}`)).statusCode).toBe(404);
    const stranger = await key(["projects"]);
    expect((await stranger.call("GET", `/api/projects/${slug}`)).statusCode).toBe(403);
    expect((await stranger.call("POST", "/api/projects", { slug, name: "P2" })).statusCode).toBe(409);
  });
});
