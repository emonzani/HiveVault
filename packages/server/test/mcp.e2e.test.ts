// MCP server over real HTTP with the official client: tools, resources, prompts, the
// classification cap (nothing above "interno", whatever the account clearance), audit of the
// reads, writes only with the write scope, proposals waiting for a person.
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthService } from "@cb/auth";
import { FsBlobStore } from "@cb/blobs";
import { SourceStore } from "@cb/ingest";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { Curator } from "@cb/hive";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL, type ChatRequest } from "@cb/models";
import { ulid } from "@cb/shared";
import { buildApp } from "../src/app.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
await dispatcher.addEndpoint(new MockEndpoint({ kind: "rerank" }));
let lastPrompt = "";
await dispatcher.addEndpoint(
  new MockEndpoint({
    kind: "chat",
    id: "scripted",
    script: (req: ChatRequest) => {
      lastPrompt = String(req.messages.at(-1)?.content ?? "");
      const id = /<pagina id="([^"]+)"/.exec(lastPrompt)?.[1] ?? "x";
      return { content: `Il cliente ha 120 postazioni ^[${id}] ^[inventato_123].`, usage: { promptTokens: 300, completionTokens: 20 } };
    },
  }),
);
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: ["http://localhost"] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const app = sql
  ? await buildApp({
      sql,
      auth: auth!,
      vaults: vaults!,
      search: new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }),
      secureCookies: false,
      loginRateLimitPerMin: 10_000,
      mcp: { pages: pages!, dispatcher },
    })
  : undefined;
// The client talks to the app through inject: the full MCP protocol and the HTTP route, without
// a socket. On the development machine the antivirus rewrites local HTTP responses (see the
// phase 6 report), which a strict client refuses.
const base = "http://brain.test";
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

async function account(scopes: ("read" | "write")[], vaultIds: string[], clearance: number) {
  const p = await auth!.principals.createApiAccount({ name: `mcp-${run}-${Math.random().toString(36).slice(2, 6)}`, scopes, clearance });
  for (const v of vaultIds) await auth!.access.grant(p.id, v, scopes.includes("write") ? "write" : "read", null);
  const { key } = await auth!.apiKeys.issue(p.id);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: injectFetch, requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  clients.push(client);
  return { id: p.id, client };
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");
const md = (t: string, cls: string, body: string, type = "entity/company") => `---\ntitle: ${t}\ntype: ${type}\nclassification: ${cls}\n---\n# ${t}\n\n${body}\n`;

describe("MCP server", () => {
  db()("tools, resources and prompts; never above interno; reads audited; writes need a person", async () => {
    const v = await vaults!.create({ kind: "space", slug: `mcpv-${run}`, name: "Clienti MCP" });
    const other = await vaults!.create({ kind: "space", slug: `mcpo-${run}`, name: "Altro" });
    const acme = await pages!.upsert({
      vaultId: v.id,
      markdown: md(`Acme ${run}`, "interno", `## Stato attuale\n- Postazioni: 120 ^[src_fake#c0]\n- Referente: [[Nome CognomeOOO ${run}]]\n\n## Timeline\n- 2026-09-01 · Firma del rinnovo\n- 2025-03-10 · Primo contratto`),
    });
    await pages!.upsert({ vaultId: v.id, markdown: md(`Nome CognomeOOO ${run}`, "pubblico", `## Stato attuale\n- Ruolo: CTO di [[Acme ${run}]]\n\n## Timeline\n- 2026-05-02 · Incontro con Acme ${run}`, "entity/person") });
    const ris = await pages!.upsert({ vaultId: v.id, markdown: md(`Riservato ${run}`, "riservato", `Acme ${run} postazioni: margine del 40%.`) });
    await pages!.upsert({ vaultId: v.id, markdown: md(`Segreto ${run}`, "segreto", `Acme ${run} postazioni: piano di acquisizione.`) });
    await pages!.upsert({ vaultId: other.id, markdown: md(`Fuori ${run}`, "interno", `Acme ${run} postazioni in un altro vault.`) });
    await new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL }).run(v.id);

    // an account with clearance "segreto": MCP still caps it at "interno"
    const { id: accId, client } = await account(["read"], [v.id], 3);

    const listed = (await client.listTools()).tools;
    // the input schemas reach the cloud agent with their parameters (zod → JSON Schema)
    const searchTool = listed.find((t) => t.name === "brain_search")!;
    expect(searchTool.inputSchema.properties).toHaveProperty("query");
    expect(searchTool.inputSchema.required).toContain("query");
    const tools = listed.map((t) => t.name).sort();
    expect(tools).toEqual(["brain_ask", "brain_capture", "brain_journal", "brain_neighbors", "brain_overview", "brain_propose_edit", "brain_read", "brain_search", "brain_source", "brain_timeline"]);
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(["buongiorno", "chiudi-sessione", "cosa-sappiamo-di", "fine-giornata", "prepara-riunione", "stato-cliente"]);
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toEqual([`brain://mcpv-${run}/index`, `brain://mcpv-${run}/llms.txt`, `brain://mcpv-${run}/changes`]);

    const overview = text(await client.callTool({ name: "brain_overview", arguments: {} }));
    expect(overview).toContain(`Clienti MCP`);
    expect(overview).not.toContain("Altro");
    expect(overview).not.toContain(`Riservato ${run}`);

    const search = text(await client.callTool({ name: "brain_search", arguments: { query: `Acme ${run} postazioni` } }));
    expect(search).toContain(`[${acme.page.id}]`);
    expect(search).toMatch(/token/);
    for (const hidden of [`Riservato ${run}`, `Segreto ${run}`, `Fuori ${run}`]) expect(search).not.toContain(hidden);

    const read = text(await client.callTool({ name: "brain_read", arguments: { id: `Acme ${run}`, max_tokens: 300 } }));
    expect(read).toContain("Postazioni: 120");
    expect(read).toContain(`Cita come ^[${acme.page.id}#sezione]`);
    const denied = await client.callTool({ name: "brain_read", arguments: { id: ris.page.id } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/non trovata/);

    const nb = text(await client.callTool({ name: "brain_neighbors", arguments: { id: acme.page.id } }));
    expect(nb).toContain(`Nome CognomeOOO ${run}`);
    const tl = text(await client.callTool({ name: "brain_timeline", arguments: { entity: `Acme ${run}` } }));
    expect(tl.indexOf("2026-09-01")).toBeLessThan(tl.indexOf("2025-03-10"));
    expect(tl).toContain(`2026-05-02 · Incontro con Acme ${run} (da [`);
    const tlRange = text(await client.callTool({ name: "brain_timeline", arguments: { entity: `Acme ${run}`, from: "2026-01-01" } }));
    expect(tlRange).not.toContain("2025-03-10");
    const src = text(await client.callTool({ name: "brain_source", arguments: { ref: `${acme.page.id}#stato-attuale` } }));
    expect(src).toContain("Postazioni: 120");

    const llms = await client.readResource({ uri: `brain://mcpv-${run}/llms.txt` });
    const llmsText = (llms.contents[0] as { text: string }).text;
    expect(llmsText).toContain(`Acme ${run}`);
    expect(llmsText).not.toContain(`Riservato ${run}`);
    expect(llmsText).not.toContain(`Segreto ${run}`);
    const pageRes = await client.readResource({ uri: `brain://mcpv-${run}/page/${ris.page.id}` });
    expect((pageRes.contents[0] as { text: string }).text).toMatch(/non trovata/);
    const prompt = await client.getPrompt({ name: "stato-cliente", arguments: { cliente: `Acme ${run}` } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain(`Acme ${run}`);

    // brain_ask: the local model answers on the readable context; unknown citations are flagged
    const ask = text(await client.callTool({ name: "brain_ask", arguments: { question: `Quante postazioni ha Acme ${run}?` } }));
    expect(ask).toContain("120 postazioni");
    expect(ask).toContain("inventato_123");
    expect(lastPrompt).not.toContain("margine del 40%");

    // read-only account: no writes
    const cap = await client.callTool({ name: "brain_capture", arguments: { title: "Nota", content: "testo" } });
    expect(cap.isError).toBe(true);

    // reads are in the audit, with the MCP channel (they feed "Cosa ha letto l'agente cloud")
    await auth!.audit.flush?.();
    await new Promise((r) => setTimeout(r, 1200));
    const audit = await sql!<{ action: string; resource: string | null }[]>`
      select action, resource from audit_log where principal_id = ${accId} and data->>'via' = 'mcp' order by id`;
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["mcp.overview", "search", "page.read", "mcp.neighbors", "mcp.timeline"]));
    expect(audit.some((x) => x.action === "page.read" && x.resource === acme.page.id)).toBe(true);
    expect(audit.some((x) => x.resource === ris.page.id)).toBe(false);

    // write account: capture into the inbox; proposals wait for a person
    const { client: writer } = await account(["read", "write"], [v.id], 1);
    const saved = text(await writer.callTool({ name: "brain_capture", arguments: { title: `Sintesi ${run}`, content: `Acme ha 120 postazioni ^[${acme.page.id}].`, vault: `mcpv-${run}` } }));
    expect(saved).toMatch(/Nota salvata: \[pag_/);
    const [note] = await sql!<{ path: string; type: string; frontmatter: { captured_by: string } }[]>`select path, type, frontmatter from pages where vault_id = ${v.id} and title = ${`Sintesi ${run}`}`;
    expect(note).toMatchObject({ type: "note/capture" });
    expect(note!.path).toMatch(/^inbox\//);

    // work journal: hooked to real pages only, in the inbox; the day lists its sessions
    const journal = (args: Record<string, unknown>) => writer.callTool({ name: "brain_journal", arguments: { vault: `mcpv-${run}`, ...args } });
    expect((await journal({ action: "sessione", fatto: ["x"] })).isError).toBe(true);
    const ghost = await journal({ action: "sessione", fatto: ["x"], links: [`Cliente inventato ${run}`] });
    expect(text(ghost)).toContain("non esistono");
    const sess = text(await journal({ action: "sessione", summary: "Rinnovo preparato.", fatto: ["Offerta rivista"], deciso: ["Sconto del 5%: cliente storico"], aperto: ["Firma del contratto"], links: [`[[Acme ${run}]]`] }));
    expect(sess).toMatch(/Nota di diario salvata: \[pag_.*inbox\/diario/);
    const day = text(await journal({ action: "giornata", fatto: ["Rinnovo Acme"], links: [`Acme ${run}`] }));
    expect(day).toContain("Giornata ");
    const [jd] = await sql!<{ path: string; body: string; frontmatter: Record<string, unknown> }[]>`
      select path, body, frontmatter from pages where vault_id = ${v.id} and type = 'note/journal' and frontmatter->>'journal' = 'giornata'`;
    expect(jd!.path).toMatch(/^inbox\/diario\/giornate\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(jd!.body).toMatch(/## Sessioni\n- \[\[Sessione \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\]/);
    expect(jd!.frontmatter).toMatchObject({ status: "done", tags: ["diario", "diario/giornata"] });
    const [link] = await sql!<{ dst: string | null }[]>`select l.dst_page as dst from links l join pages p on p.id = l.src_page where p.vault_id = ${v.id} and p.frontmatter->>'journal' = 'sessione' and l.target_norm like 'acme%'`;
    expect(link?.dst).toBe(acme.page.id);
    const diary = text(await journal({ action: "leggi" }));
    expect(diary).toContain("## Aperto\n- Firma del contratto");
    expect(diary.indexOf("Giornata")).toBeLessThan(diary.indexOf("Sessione"));

    const prop = text(
      await writer.callTool({
        name: "brain_propose_edit",
        arguments: { page: acme.page.id, section: "stato-attuale", text: "- Postazioni: 150 ^[src_fake#c1]\n- Referente: [[Nome CognomeOOO " + run + "]]", rationale: "Email del 2026-10-01" },
      }),
    );
    expect(prop).toMatch(/Proposta registrata/);
    const before = (await PageStore.get(sql!, acme.page.id))!;
    expect(before.body).toContain("Postazioni: 120");
    const curator = new Curator(sql!, pages!);
    const [item] = await curator.list([v.id], { kind: "proposal" });
    expect(item).toMatchObject({ kind: "proposal", pageId: acme.page.id });
    const applied = await curator.applyProposal(item!.id, accId);
    expect(applied.version).toBe(before.version + 1);
    const after = (await PageStore.get(sql!, acme.page.id))!;
    expect(after.body).toContain("Postazioni: 150");
    expect(after.body).toContain("## Timeline");
  });

  db()("only API accounts with a key; GET is not allowed", async () => {
    expect((await injectFetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await injectFetch(`${base}/mcp`)).status).toBe(405);
    const user = await auth!.principals.createUser({ username: `mcpu-${run}`, displayName: "U" });
    const login = await auth!.sessions.create(user.id, "totp");
    const r = await injectFetch(`${base}/mcp`, { method: "POST", headers: { cookie: `cb_session=${login.token}`, "x-cb-csrf": login.csrf, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(r.status).toBe(403);
  });
});

describe("documents newer than the pages (M15, M16, M17)", () => {
  db()("search marks documents not compiled, a read warns of newer documents, changes lists what is new", async () => {
    const v = await vaults!.create({ kind: "space", slug: `mcpn-${run}`, name: "Novità" });
    const page = await pages!.upsert({ vaultId: v.id, markdown: md(`Delta ${run} S.p.A.`, "interno", `## Stato attuale\n- Postazioni: 300 ^[src_vecchia#c0]`) });
    // `since` has whole seconds: the page must be written in an earlier second
    await new Promise((r) => setTimeout(r, 1100));
    const { since } = (await sql!<{ since: string }[]>`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as since`)[0]!;
    await new Promise((r) => setTimeout(r, 1100));
    // a document written after the page, not compiled, that names its subject
    const store = new SourceStore(sql!, new FsBlobStore(await mkdtemp(path.join(os.tmpdir(), "cb-mcp-")), randomBytes(32)));
    const text1 = `# Rinnovo\n\nDelta ${run} S.p.A. passa a 450 postazioni dal primo gennaio.`;
    const { source } = await store.create(Buffer.from(text1), { vaultId: v.id, name: "rinnovo.md", origin: "upload", classification: 1 });
    await store.update(source.id, { status: "indexed", level: 1 });
    await store.writeChunks((await store.get(source.id))!, text1, "italian", { minTokens: 1 });

    const { client } = await account(["read"], [v.id], 1);
    const search = text(await client.callTool({ name: "brain_search", arguments: { query: `Delta ${run} postazioni` } }));
    expect(search).toContain(`[${source.id}]`);
    expect(search).toContain("documento recente, non ancora compilato");
    expect(search).toMatch(/1 risultato è un documento non ancora compilati|non ancora compilati: le pagine/);

    // the link task writes the page after the document came: the page still does not know it
    await pages!.upsert({ vaultId: v.id, id: page.page.id, markdown: md(`Delta ${run} S.p.A.`, "interno", `## Stato attuale\n- Postazioni: 300 ^[src_vecchia#c0]\n\nVedi [[Novità]].`) });
    const read = text(await client.callTool({ name: "brain_read", arguments: { id: page.page.id } }));
    expect(read).toContain("Attenzione: un documento più recente della pagina parla dello stesso soggetto");
    expect(read).toContain(`[${source.id}] «rinnovo.md»`);

    const changes = await client.readResource({ uri: `brain://mcpn-${run}/changes?since=${since}` });
    const c = (changes.contents[0] as { text: string }).text;
    expect(c).toContain(`# Modifiche di Novità dal ${since}`);
    expect(c).toContain(`[${source.id}] «rinnovo.md» · I1`);
    // written before `since`, written again after it: listed as a new version, not as a new page
    expect(c).toContain(`[${page.page.id}] **Delta ${run} S.p.A.** — entity/company · versione 2`);
    expect(c).toMatch(new RegExp(`Prossima lettura: brain://mcpn-${run}/changes\\?since=\\d{4}-\\d{2}-\\d{2}T`));
    const bad = await client.readResource({ uri: `brain://mcpn-${run}/changes?since=ieri` });
    expect((bad.contents[0] as { text: string }).text).toContain("non è una data");
  });
});

describe("llms.txt", () => {
  db()("is public and describes the MCP tools", async () => {
    const r = await app!.inject({ method: "GET", url: "/llms.txt" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect(r.body).toContain("brain_search");
    expect(r.body).toContain("POST /mcp");
  });
});
