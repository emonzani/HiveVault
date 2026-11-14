// Coding agents (one install per person) on project vaults: a key bound to a user reads
// what the user may (not the user's personal vault) through MCP, writes only project vaults
// (sections and inbox), never writes directly through the other REST routes; an inbox note in a
// project vault goes to ingestion as a source; the status of a project vault for the panel.
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthService, type Scope } from "@cb/auth";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
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
await dispatcher.addEndpoint(new MockEndpoint({ kind: "rerank" }));
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: ["http://localhost"] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
// ingestion stand-in: records the uploads the way IngestService.upload answers
const uploads: { vaultId: string; name: string; text: string; classification?: number; compile?: boolean }[] = [];
const ingest = {
  async upload(vaultId: string, data: Buffer, name: string, _by: string | null, o: { classification?: number; compile?: boolean } = {}) {
    uploads.push({ vaultId, name, text: data.toString("utf8"), ...o });
    return { source: { id: `src_test${uploads.length}`, name }, created: true, taskId: `tsk_${uploads.length}` };
  },
};
const app = sql
  ? await buildApp({
      sql,
      auth: auth!,
      vaults: vaults!,
      search: new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }),
      secureCookies: false,
      loginRateLimitPerMin: 10_000,
      mcp: { pages: pages!, dispatcher, ingest },
    })
  : undefined;
const injectFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const r = await app!.inject({ method: (init?.method ?? "GET") as "GET", url: url.pathname + url.search, headers, ...(init?.body ? { payload: String(init.body) } : {}) });
  const out = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !["content-length", "transfer-encoding", "connection"].includes(k)) out.set(k, String(v));
  return new Response(r.statusCode === 204 ? null : r.body, { status: r.statusCode, headers: out });
};
const clients: Client[] = [];
afterAll(async () => {
  for (const c of clients) await c.close();
  await app?.close();
  await auth?.stop();
  dispatcher.stop();
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

async function key(scopes: Scope[], userId?: string, clearance = 1) {
  const p = await auth!.principals.createApiAccount({ name: `ag-${run}-${Math.random().toString(36).slice(2, 6)}`, scopes, clearance, userId: userId ?? null });
  const { key } = await auth!.apiKeys.issue(p.id);
  return { id: p.id, key };
}
async function mcp(k: string) {
  const c = new Client({ name: "coding-agent", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://brain.test/mcp"), { fetch: injectFetch, requestInit: { headers: { Authorization: `Bearer ${k}` } } }));
  clients.push(c);
  return c;
}
const rest = (k: string, method: string, url: string, body?: unknown) =>
  app!.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${k}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
const vaultId = async (slug: string) => (await sql!<{ id: string }[]>`select id from vaults where slug = ${slug}`)[0]!.id;

describe("coding agents on project vaults", () => {
  db()("a key bound to a user reads what the user may, writes only project vaults, sends inbox notes to ingestion", async () => {
    // Anna works on alfa; her team reads beta; gamma is nobody's business of hers
    const anna = await auth!.principals.createUser({ username: `anna-${run}`, displayName: "Anna", clearance: 2 });
    const team = await auth!.principals.createTeam({ name: `dev-${run}` });
    await auth!.principals.addMember(team.id, anna.id, null);
    const other = await key(["projects"]);
    for (const slug of [`beta-${run}`, `gamma-${run}`]) {
      expect((await rest(other.key, "POST", "/api/projects", { slug, name: slug })).statusCode).toBe(201);
      expect((await rest(other.key, "PUT", `/api/projects/${slug}/docs/analisi-tecnica`, { markdown: `## Rendering di ${slug}\nOctree per il culling.`, summary: "Rendering." })).statusCode).toBe(200);
    }
    await auth!.access.grant(team.id, await vaultId(`beta-${run}`), "read", null);
    const cell = await vaults!.create({ kind: "cell", slug: `anna-cell-${run}`, name: "Cella di Anna", owner: `user:${anna.id}` });
    await pages!.upsert({ vaultId: cell.id, markdown: `---\ntitle: Appunti ${run}\nclassification: interno\n---\nOctree e appunti privati.` });

    // Anna's coding agent: one key, bound to her, scopes read + projects, clearance 3 (capped by hers, 2, and by MCP, 1)
    const agent = await key(["read", "projects"], anna.id, 3);
    const created = await rest(agent.key, "POST", "/api/projects", { slug: `alfa-${run}`, name: `alfa-${run}` });
    expect(created.statusCode).toBe(201);
    const alfa = await vaultId(`alfa-${run}`);
    // the person sees the project her coding agent created
    expect((await sql!<{ permission: string }[]>`select permission from vault_grants where principal_id = ${anna.id} and vault_id = ${alfa}`)[0]?.permission).toBe("write");
    expect((await rest(agent.key, "PUT", `/api/projects/alfa-${run}/docs/specifiche`, { markdown: "## Requisiti\n- Octree con LOD.", summary: "Requisiti." })).statusCode).toBe(200);
    for (const v of [alfa, await vaultId(`beta-${run}`), await vaultId(`gamma-${run}`)]) await new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL }).run(v);

    const c = await mcp(agent.key);
    const overview = text(await c.callTool({ name: "brain_overview", arguments: {} }));
    expect(overview).toContain(`alfa-${run}`);
    expect(overview).toContain(`beta-${run}`); // through her team
    expect(overview).not.toContain(`gamma-${run}`);
    expect(overview).not.toContain(`anna-cell-${run}`); // her personal cell does not pass to the key
    const found = text(await c.callTool({ name: "brain_search", arguments: { query: "octree", limit: 10 } }));
    expect(found).toContain(`beta-${run}`);
    expect(found).not.toContain(`Appunti ${run}`);
    const llms = (await c.readResource({ uri: `brain://alfa-${run}/llms.txt` })).contents.map((x) => (x as { text: string }).text).join("");
    expect(llms).toContain("Specifiche");

    // inbox of her project: a source for ingestion (the default in a project vault), "interno"
    const note = await c.callTool({ name: "brain_capture", arguments: { title: `Decisione LOD ${run}`, content: "Deciso: tre livelli di LOD.", vault: `alfa-${run}` } });
    expect(note.isError).toBeFalsy();
    expect(text(note)).toContain("inviata all'ingestion");
    expect(uploads.at(-1)).toMatchObject({ vaultId: alfa, classification: 1, compile: true });
    expect(uploads.at(-1)!.name).toMatch(/^\d{4}-\d{2}-\d{2}-decisione-lod-/);
    expect(uploads.at(-1)!.text).toContain("Deciso: tre livelli di LOD.");
    // compile false: a note page in inbox/
    const page = await c.callTool({ name: "brain_capture", arguments: { title: `Nota ${run}`, content: "Una nota.", vault: `alfa-${run}`, compile: false } });
    expect(text(page)).toContain("cartella inbox");
    // a project she only reads: refused
    const refused = await c.callTool({ name: "brain_capture", arguments: { title: `No ${run}`, content: "x", vault: `beta-${run}` } });
    expect(refused.isError).toBe(true);

    // no direct writes through the other routes, not even in her own project
    const direct = await rest(agent.key, "POST", `/api/vaults/${alfa}/pages`, { title: `Diretta ${run}`, body: "x" });
    expect(direct.statusCode).toBe(403);
    // a key with "ingest" keeps its write (importers)
    const importer = await key(["ingest"]);
    await auth!.access.grant(importer.id, alfa, "write", null);
    expect((await rest(importer.key, "POST", `/api/vaults/${alfa}/pages`, { title: `Import ${run}`, body: "x" })).statusCode).toBe(201);

    // the panel: counts of the project vault
    const status = await rest(agent.key, "GET", `/api/projects/alfa-${run}/status`);
    expect(status.statusCode).toBe(200);
    const s = status.json() as { pages: { pages: number; inbox: number; sections: number }; work: { queued: number }; dream: unknown; sources: Record<string, number> };
    expect(s.pages.sections).toBe(1);
    expect(s.pages.inbox).toBe(1);
    expect(s.dream).toBeNull();
    // not readable: 403
    expect((await rest(agent.key, "GET", `/api/projects/gamma-${run}/status`)).statusCode).toBe(403);

    // Anna suspended: her key reaches nothing
    await auth!.principals.update(anna.id, { status: "suspended" });
    const after = text(await (await mcp(agent.key)).callTool({ name: "brain_overview", arguments: {} }));
    expect(after).not.toContain(`alfa-${run}`);
    expect((await rest(agent.key, "GET", `/api/projects/alfa-${run}`)).statusCode).toBe(403);
  });

  db()("a key with the projects scope alone still has no MCP; a key binds only to a user", async () => {
    const only = await key(["projects"]);
    expect((await rest(only.key, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(403);
    await expect(auth!.principals.createApiAccount({ name: `bad-${run}`, scopes: ["read"], userId: only.id })).rejects.toThrow("solo a un utente");
  });
});
