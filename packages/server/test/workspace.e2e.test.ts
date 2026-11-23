// API of the web interface (phase 4) over HTTP: tree, full page with links across vaults and
// citations, backlinks and mentions, editor saves with conflicts, history, suggestions, graph,
// Cloud agent notice and reads, access control, inline originals and the app shell.
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { AuthService, base32Decode, totp } from "@cb/auth";
import { FsBlobStore } from "@cb/blobs";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { Compiler, defineIngestTask, IngestService, SourceStore } from "@cb/ingest";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL } from "@cb/models";
import { parseFile } from "@cb/parsers";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { buildApp } from "../src/app.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-ws-e2e-"));
const webDir = path.join(tmp, "web");
await mkdir(path.join(webDir, "assets"), { recursive: true });
await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>HiveVault</title>");
await writeFile(path.join(webDir, "assets", "main-abc123.js"), "console.log(1)");
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: ["http://localhost"] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const search = sql ? new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }) : undefined;
const store = sql ? new SourceStore(sql, new FsBlobStore(path.join(tmp, "blobs"), randomBytes(32))) : undefined;
const task = sql
  ? defineIngestTask({
      store: store!,
      parse: (d, n) => parseFile(d, n),
      indexer: () => null,
      compiler: new Compiler(sql, store!, new PageStore(sql), search!, dispatcher, { useModel: "never" }),
      chunk: { minTokens: 1 },
      name: `ingest-ws-${run}`,
    })
  : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50 }).register(task!) : undefined;
const ingest = sql ? new IngestService(sql, store!, engine!, task!, undefined, { compileUploads: false }) : undefined;
await engine?.start();
const app: FastifyInstance | undefined = sql
  ? await buildApp({ sql, auth: auth!, vaults: vaults!, search: search!, ingest: ingest!, secureCookies: false, loginRateLimitPerMin: 10_000, webDir })
  : undefined;
afterAll(async () => {
  await app?.close();
  await engine?.stop();
  await auth?.stop();
  dispatcher.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;

class Client {
  cookie = "";
  csrf = "";
  id = "";
  async call(method: string, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = {};
    if (this.cookie) h.cookie = this.cookie;
    if (method !== "GET" && this.csrf) h["x-cb-csrf"] = this.csrf;
    return app!.inject({ method: method as "GET", url, headers: h, ...(payload !== undefined ? { payload: payload as string } : {}) });
  }
  upload(vaultId: string, name: string, data: Buffer) {
    const boundary = "----cb" + randomBytes(6).toString("hex");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app!.inject({ method: "POST", url: `/api/vaults/${vaultId}/sources`, headers: { cookie: this.cookie, "x-cb-csrf": this.csrf, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  }
}

async function user(grants: [string, "read" | "write"][], clearance = 1): Promise<Client> {
  const p = await auth!.principals.createUser({ username: `w${run}-${Math.random().toString(36).slice(2, 7)}`, displayName: "U", clearance });
  for (const [v, perm] of grants) await auth!.access.grant(p.id, v, perm, null);
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  const start = await auth!.totp.startEnrollment(code);
  const r = await auth!.enrollConfirm(code, totp(base32Decode(start.secretBase32)));
  const c = new Client();
  c.cookie = `cb_session=${r.session.token}`;
  c.csrf = r.session.csrf;
  c.id = p.id;
  return c;
}

const md = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n# ${title}\n\n${body}`;

describe("web interface API", () => {
  db()("tree, full page with cross-vault links and citations, backlinks, mentions, graph, suggestions", async () => {
    const a = await vaults!.create({ kind: "space", slug: `wsa-${run}`, name: "A" });
    const b = await vaults!.create({ kind: "space", slug: `wsb-${run}`, name: "B" });
    const hidden = await vaults!.create({ kind: "space", slug: `wsh-${run}`, name: "H" });
    const u = await user([[a.id, "write"], [b.id, "read"]]);

    // a source in A, indexed, cited by a page
    const up = await u.upload(a.id, "contratto.md", Buffer.from(`# Contratto ${run}\n\nIl cliente Orione-${run} ha 300 postazioni.`));
    expect(up.statusCode).toBe(202);
    const srcId = up.json().sources[0].id as string;
    for (let i = 0; i < 100 && (await sql!`select level from sources where id = ${srcId}`)[0]!.level < 1; i++) await new Promise((r) => setTimeout(r, 100));

    const orione = await pages!.upsert({ vaultId: a.id, markdown: md(`Orione ${run}`, `## Stato attuale\n- 300 postazioni ^[${srcId}#c0]\n- Progetto [[Vega ${run}]] e [[Segreto ${run}]] e [[Manca ${run}]]`, "type: entity/company\n") });
    const vega = await pages!.upsert({ vaultId: b.id, markdown: md(`Vega ${run}`, `Per [[Orione ${run}]].`, "type: entity/project\n") });
    await pages!.upsert({ vaultId: hidden.id, markdown: md(`Segreto ${run}`, `Collegato a [[Orione ${run}]].`) });
    await pages!.upsert({ vaultId: a.id, markdown: md(`Nota ${run}`, `Abbiamo parlato con Orione ${run} ieri.`) });
    for (let i = 0; i < 5; i++) await pages!.upsert({ vaultId: a.id, markdown: md(`Elenco ${run} ${String(i).padStart(2, "0")}`, "x", "type: entity/company\n") });

    // folders and keyset pagination in title order
    const folders = (await u.call("GET", `/api/vaults/${a.id}/folders`)).json() as { folder: string; count: number }[];
    expect(folders.find((f) => f.folder === "entity")?.count).toBe(6);
    const p1 = (await u.call("GET", `/api/vaults/${a.id}/pages?folder=entity&limit=4`)).json();
    expect(p1.items).toHaveLength(4);
    expect(p1.next).toBeTruthy();
    const p2 = (await u.call("GET", `/api/vaults/${a.id}/pages?folder=entity&limit=4&cursor=${p1.next}`)).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.next).toBeNull();
    const titles = [...p1.items, ...p2.items].map((x: { title: string }) => x.title);
    expect(titles).toEqual([...titles].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
    expect((await u.call("GET", `/api/vaults/${hidden.id}/folders`)).statusCode).toBe(403);

    // full page: the link to B resolves (readable), the one to the hidden vault does not
    const full = (await u.call("GET", `/api/pages/${orione.page.id}/full`)).json();
    const byTarget = Object.fromEntries(full.links.map((l: { title: string | null; pageId: string | null; raw: string }) => [l.raw, l.pageId]));
    expect(byTarget[`[[Vega ${run}]]`]).toBe(vega.page.id);
    expect(byTarget[`[[Segreto ${run}]]`]).toBeNull();
    expect(byTarget[`[[Manca ${run}]]`]).toBeNull();
    expect(full.citations).toEqual([expect.objectContaining({ ref: `${srcId}#c0`, kind: "source", chunkId: `${srcId}:0`, excerpt: expect.stringContaining("300 postazioni") })]);
    expect(full).toMatchObject({ canWrite: true, permission: "write", agentReadable: false, backlinks: 1 });

    // backlinks: Vega links (B readable), Segreto does not show (hidden vault); Nota mentions
    const bl = (await u.call("GET", `/api/pages/${orione.page.id}/backlinks`)).json();
    expect(bl.linked.map((x: { title: string }) => x.title)).toEqual([`Vega ${run}`]);
    expect(bl.mentions.map((x: { title: string }) => x.title)).toContain(`Nota ${run}`);

    // suggestions: prefix and alias match, only readable vaults
    const sg = (await u.call("GET", `/api/suggest?q=${encodeURIComponent(`segreto ${run}`)}`)).json();
    expect(sg.every((x: { vaultId: string; title: string }) => x.vaultId !== hidden.id && x.title !== `Segreto ${run}`)).toBe(true);
    const sv = (await u.call("GET", `/api/suggest?q=${encodeURIComponent(`veg`)}&limit=50`)).json();
    expect(sv.map((x: { id: string }) => x.id)).toContain(vega.page.id);

    // graph of the readable vaults: no node of the hidden vault
    const g = (await u.call("GET", `/api/graph?vaults=${a.id},${b.id},${hidden.id}&limit=50`)).json();
    const ids = g.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain(orione.page.id);
    expect(ids).toContain(vega.page.id);
    expect(g.nodes.every((n: { vaultId: string }) => n.vaultId !== hidden.id)).toBe(true);
    // a link between two vaults: marked as cross, so the graph draws it dashed
    expect(g.edges).toContainEqual({ from: vega.page.id, to: orione.page.id, kind: "wikilink", cross: true });

    // source text for the source view
    const chunks = (await u.call("GET", `/api/sources/${srcId}/chunks`)).json();
    expect(chunks[0]).toMatchObject({ id: `${srcId}:0`, ord: 0 });
    // inline original (text): framing allowed from the same origin only
    const orig = await u.call("GET", `/api/sources/${srcId}/original?inline=true`);
    expect(orig.headers["content-disposition"]).toMatch(/^inline/);
    expect(orig.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(String(orig.headers["content-security-policy"])).toContain("sandbox");
    const dl = await u.call("GET", `/api/sources/${srcId}/original`);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment/);
    expect(dl.headers["x-frame-options"]).toBe("DENY");
  });

  db()("editor: create, save with version check, conflict, history, delete; read-only users cannot write", async () => {
    const v = await vaults!.create({ kind: "space", slug: `wse-${run}`, name: "E" });
    const w = await user([[v.id, "write"]]);
    const r = await user([[v.id, "read"]]);

    const created = await w.call("POST", `/api/vaults/${v.id}/pages`, { title: `Bozza ${run}`, type: "decision" });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await w.call("POST", `/api/vaults/${v.id}/pages`, { title: `bozza ${run}` })).statusCode).toBe(409);
    expect((await r.call("POST", `/api/vaults/${v.id}/pages`, { title: `Altra ${run}` })).statusCode).toBe(403);
    // a name of a page above the clearance is still taken, but its title is not shown
    await pages!.upsert({ vaultId: v.id, markdown: md(`Progetto Phoenix ${run}`, "testo", `classification: segreto\naliases: [Phoenix ${run}]\n`) });
    const hidden = await w.call("POST", `/api/vaults/${v.id}/pages`, { title: `Phoenix ${run}` });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json().error.message).toBe("Esiste già una pagina con questo nome in questo vault.");
    const cleared = await user([[v.id, "write"]], 3);
    const shown = await cleared.call("POST", `/api/vaults/${v.id}/pages`, { title: `Phoenix ${run}` });
    expect(shown.statusCode).toBe(409);
    expect(shown.json().error.message).toBe(`Esiste già una pagina "Progetto Phoenix ${run}" in questo vault.`);

    const file = (await w.call("GET", `/api/pages/${id}/markdown`)).body;
    expect(file).toContain(`title: Bozza ${run}`);
    const s1 = await w.call("PUT", `/api/pages/${id}`, { markdown: `${file}\nPrima riga.\n`, baseVersion: 1 });
    expect(s1.json()).toMatchObject({ version: 2, changed: true });
    // a save that started from version 1 now conflicts
    const stale = await w.call("PUT", `/api/pages/${id}`, { markdown: `${file}\nAltro.\n`, baseVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect((await r.call("PUT", `/api/pages/${id}`, { markdown: file, baseVersion: 2 })).statusCode).toBe(403);
    // marks of the dream cycle would lock the page for everyone: refused
    for (const mark of ["hive_subject: falso", "promoted_from: [x]", "path: _inbox/bloccata.md"]) {
      const forged = await w.call("PUT", `/api/pages/${id}`, { markdown: file.replace(/^---\n/, `---\n${mark}\n`), baseVersion: 2 });
      expect(forged.statusCode, mark).toBe(400);
    }

    const hist = (await w.call("GET", `/api/pages/${id}/versions`)).json();
    expect(hist.map((x: { version: number; current: boolean }) => [x.version, x.current])).toEqual([[2, true], [1, false]]);
    expect((await w.call("GET", `/api/pages/${id}/versions/1`)).json().body).not.toContain("Prima riga");
    expect((await w.call("GET", `/api/pages/${id}/versions/2`)).json().body).toContain("Prima riga");

    // restore: version 1 comes back as version 3; readers cannot restore; the current one is refused
    expect((await r.call("POST", `/api/pages/${id}/restore`, { version: 1 })).statusCode).toBe(403);
    expect((await w.call("POST", `/api/pages/${id}/restore`, { version: 2 })).statusCode).toBe(409);
    expect((await w.call("POST", `/api/pages/${id}/restore`, { version: 9 })).statusCode).toBe(404);
    const restored = await w.call("POST", `/api/pages/${id}/restore`, { version: 1 });
    expect(restored.json()).toMatchObject({ version: 3, changed: true });
    expect((await w.call("GET", `/api/pages/${id}/full`)).json().body).not.toContain("Prima riga");
    expect((await w.call("GET", `/api/pages/${id}/versions`)).json()).toHaveLength(3);

    const audit = await sql!`select action from audit_log where resource = ${id} and principal_id = ${w.id} order by id`;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["page.create", "page.update", "page.restore"]));
    expect((await r.call("DELETE", `/api/pages/${id}`)).statusCode).toBe(403);
    expect((await w.call("DELETE", `/api/pages/${id}`)).statusCode).toBe(200);
    expect((await w.call("GET", `/api/pages/${id}/full`)).statusCode).toBe(404);
  });

  db()("cloud agent notice, badge and reads; classification hides pages above the clearance", async () => {
    const u = await user([]);
    const cell = await vaults!.create({ kind: "cell", slug: `wsc-${run}`, name: "Cella", owner: `user:${u.id}` });
    const pub = await pages!.upsert({ vaultId: cell.id, markdown: md(`Interna ${run}`, "testo", "classification: interno\n") });
    const res = await pages!.upsert({ vaultId: cell.id, markdown: md(`Riservata ${run}`, "testo", "classification: riservato\n") });

    expect((await u.call("GET", "/api/me/notice")).json().acknowledgedAt).toBeNull();
    const ack = await u.call("POST", "/api/me/notice");
    expect(ack.json().acknowledgedAt).toBeTruthy();
    expect((await sql!`select count(*)::int as n from audit_log where principal_id = ${u.id} and action = 'me.notice.ack'`)[0]!.n).toBe(1);

    // no API account yet: nothing is readable by the cloud agent
    expect((await u.call("GET", `/api/pages/${pub.page.id}/full`)).json().agentReadable).toBe(false);
    const api = await auth!.principals.createApiAccount({ name: `agent-${run}`, scopes: ["read"], clearance: 1 });
    await auth!.access.grant(api.id, cell.id, "read", null);
    expect((await u.call("GET", `/api/pages/${pub.page.id}/full`)).json().agentReadable).toBe(true);
    // riservato: never readable by the cloud agent; the user (clearance 1) does not see it at all
    expect((await u.call("GET", `/api/pages/${res.page.id}/full`)).statusCode).toBe(404);

    await sql!`insert into audit_log (principal_id, action, resource, data) values (${api.id}, 'page.read', ${pub.page.id}, ${sql!.json({ tokens: 12, classification: 1 })})`;
    const reads = (await u.call("GET", "/api/me/agent-reads")).json();
    expect(reads.reads).toEqual([expect.objectContaining({ pageId: pub.page.id, account: `agent-${run}`, tokens: 12 })]);
  });

  db()("serves the app shell for client routes, hashed assets cached for a year, API 404 stays JSON", async () => {
    const shell = await app!.inject({ method: "GET", url: "/p/qualcosa" });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain("HiveVault");
    expect(shell.headers["cache-control"]).toBe("no-cache");
    const asset = await app!.inject({ method: "GET", url: "/assets/main-abc123.js" });
    expect(asset.headers["cache-control"]).toContain("immutable");
    // a chunk of an older build is a 404, not the shell (HTML as a script would leave a blank page)
    const gone = await app!.inject({ method: "GET", url: "/assets/main-gone000.js" });
    expect(gone.statusCode).toBe(404);
    const api404 = await app!.inject({ method: "GET", url: "/api/nulla" });
    expect(api404.statusCode).toBe(404);
    // API answers are never cached; assets keep their own policy; browser features are off
    expect(api404.headers["cache-control"]).toBe("no-store");
    expect(asset.headers["cache-control"]).not.toBe("no-store");
    expect(api404.headers["permissions-policy"]).toContain("camera=()");
    expect(api404.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(api404.json().error.code).toBe("not_found");
    // without a session the API answers 401, the shell still loads (it shows the login)
    expect((await app!.inject({ method: "GET", url: "/api/recent" })).statusCode).toBe(401);
  });
});
