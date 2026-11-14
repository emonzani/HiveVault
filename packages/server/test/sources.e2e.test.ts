import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { AuthService, base32Decode, totp } from "@cb/auth";
import { FsBlobStore } from "@cb/blobs";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
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
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-src-e2e-"));
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
      indexer: () => new EmbeddingIndexer(sql, dispatcher, { model: MOCK_EMBED_MODEL }),
      compiler: new Compiler(sql, store!, new PageStore(sql), search!, dispatcher, { useModel: "never" }),
      chunk: { minTokens: 1 },
      name: `ingest-e2e-${run}`,
    })
  : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50 }).register(task!) : undefined;
const ingest = sql ? new IngestService(sql, store!, engine!, task!, undefined, { compileUploads: false }) : undefined;
await engine?.start();
const app: FastifyInstance | undefined = sql
  ? await buildApp({ sql, auth: auth!, vaults: vaults!, search: search!, ingest: ingest!, secureCookies: false, loginRateLimitPerMin: 10_000, uploadMaxBytes: 64 * 1024 })
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

class Client {
  cookie = "";
  csrf = "";
  bearer = "";
  async call(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    if (method !== "GET" && this.csrf) h["x-cb-csrf"] = this.csrf;
    return app!.inject({ method: method as "GET", url, headers: h, ...(payload !== undefined ? { payload: payload as string } : {}) });
  }
  upload(vaultId: string, files: { name: string; data: Buffer }[], fields: Record<string, string> = {}) {
    const boundary = "----cb" + randomBytes(6).toString("hex");
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    for (const f of files) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.data, Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return this.call("POST", `/api/vaults/${vaultId}/sources`, Buffer.concat(parts) as unknown as string, { "content-type": `multipart/form-data; boundary=${boundary}` });
  }
}

async function user(perm: "read" | "write" | "curate" | null, vaultId: string): Promise<Client> {
  const p = await auth!.principals.createUser({ username: `s${run}-${Math.random().toString(36).slice(2, 7)}`, displayName: "U" });
  if (perm) await auth!.access.grant(p.id, vaultId, perm, null);
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  const start = await auth!.totp.startEnrollment(code);
  const r = await auth!.enrollConfirm(code, totp(base32Decode(start.secretBase32)));
  const c = new Client();
  c.cookie = `cb_session=${r.session.token}`;
  c.csrf = r.session.csrf;
  return c;
}

async function waitLevel(c: Client, id: string, level: number) {
  for (let i = 0; i < 200; i++) {
    const s = (await c.call("GET", `/api/sources/${id}`)).json();
    // the level is saved before the task ends: a source is still "busy" until its task stops running
    if (s.level >= level && s.task?.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout");
}

describe("sources over HTTP", () => {
  db()("upload, status, search, original download; permissions per role", async () => {
    const v = await vaults!.create({ kind: "space", slug: `srcapi-${run}`, name: "S" });
    const writer = await user("write", v.id);
    const reader = await user("read", v.id);
    const content = Buffer.from(`# Offerta ${run}\n\nLa fornitura Quarzo-${run} costa 31 euro per postazione.`);
    const up = await writer.upload(v.id, [{ name: "offerta.md", data: content }]);
    expect(up.statusCode).toBe(202);
    const id = up.json().sources[0].id;
    const st = await waitLevel(writer, id, 2);
    expect(st).toMatchObject({ status: "embedded", chunks: 1, task: { status: "done" } });

    const s = (await reader.call("POST", "/api/search", { query: `Quarzo-${run} postazione` })).json();
    expect(s.hits[0].id).toBe(id);
    const orig = await reader.call("GET", `/api/sources/${id}/original`);
    expect(orig.statusCode).toBe(200);
    expect(orig.rawPayload.equals(content)).toBe(true);
    expect(orig.headers["content-disposition"]).toContain("offerta.md");

    expect((await reader.upload(v.id, [{ name: "x.txt", data: Buffer.from("x") }])).statusCode).toBe(403);
    const outsider = await user(null, v.id);
    expect((await outsider.call("GET", `/api/sources/${id}`)).statusCode).toBe(404);
    expect((await outsider.call("GET", `/api/vaults/${v.id}/sources`)).statusCode).toBe(403);
    expect((await writer.call("GET", `/api/vaults/${v.id}/sources`)).json().map((x: { id: string }) => x.id)).toContain(id);
  });

  db()("documents in the pipeline: listed for readers of the vault while their task lives", async () => {
    const v = await vaults!.create({ kind: "space", slug: `srcwork-${run}`, name: "W" });
    const writer = await user("write", v.id);
    const reader = await user("read", v.id);
    const other = await user(null, v.id);
    const id = (await writer.upload(v.id, [{ name: "lavoro.md", data: Buffer.from(`# Lavoro ${run}

Testo.`) }])).json().sources[0].id;
    await waitLevel(writer, id, 1);
    // a compile that waits for the chat model: the source stays at its level, the task lives
    const [s] = await sql!<{ taskId: string }[]>`select task_id as "taskId" from sources where id = ${id}`;
    await sql!`update tasks set status = 'sleeping', phase = 'compile', run_after = now() + interval '1 hour' where id = ${s!.taskId}`;
    const w = (await reader.call("GET", "/api/sources/working")).json();
    expect(w).toContainEqual({ id, phase: "compile", task: "sleeping", waitingModel: true });
    expect((await other.call("GET", "/api/sources/working")).json()).not.toContainEqual(expect.objectContaining({ id }));
    await sql!`update tasks set status = 'done', finished_at = now() where id = ${s!.taskId}`;
    expect((await reader.call("GET", "/api/sources/working")).json()).not.toContainEqual(expect.objectContaining({ id }));
  });

  db()("API accounts never receive original files, and need the ingest scope to upload", async () => {
    const v = await vaults!.create({ kind: "space", slug: `srcapi2-${run}`, name: "S2" });
    const writer = await user("write", v.id);
    const id = (await writer.upload(v.id, [{ name: "a.txt", data: Buffer.from("segreto aziendale " + run) }])).json().sources[0].id;
    await waitLevel(writer, id, 1);
    const acct = await auth!.principals.createApiAccount({ name: `bot-${run}-${Math.random().toString(36).slice(2, 6)}`, scopes: ["read"] });
    await auth!.access.grant(acct.id, v.id, "write", null);
    const bot = new Client();
    bot.bearer = (await auth!.apiKeys.issue(acct.id)).key;
    expect((await bot.call("GET", `/api/sources/${id}`)).statusCode).toBe(200);
    const o = await bot.call("GET", `/api/sources/${id}/original`);
    expect(o.statusCode).toBe(403);
    expect(o.json().error.message).toMatch(/originali/);
    expect((await bot.upload(v.id, [{ name: "b.txt", data: Buffer.from("b") }])).statusCode).toBe(403); // read scope caps write
  });

  db()("refuses oversized files, internal links; compile now reaches I3", async () => {
    const v = await vaults!.create({ kind: "space", slug: `srcapi3-${run}`, name: "S3" });
    const writer = await user("write", v.id);
    const big = await writer.upload(v.id, [{ name: "grande.txt", data: Buffer.alloc(100 * 1024, 97) }]);
    expect(big.statusCode).toBe(400);
    expect(big.json().error.message).toMatch(/supera il limite/);
    const link = await writer.call("POST", `/api/vaults/${v.id}/links`, { url: "http://192.168.1.10:8000/v1/models" });
    expect(link.statusCode).toBe(400);
    expect(link.json().error.message).toMatch(/rete interna/);
    const id = (await writer.upload(v.id, [{ name: "c.md", data: Buffer.from(`# Decisione ${run}\n\nScegliamo PostgreSQL.`) }])).json().sources[0].id;
    await waitLevel(writer, id, 2);
    expect((await writer.call("POST", `/api/sources/${id}/compile`)).statusCode).toBe(200);
    const done = await waitLevel(writer, id, 3);
    expect(done.compiledPage).toMatch(/^spg_/);
  });

  db()("review: mark as reviewed, delete with its pages and files, replace a link", async () => {
    const v = await vaults!.create({ kind: "space", slug: `srcrev-${run}`, name: "R" });
    const writer = await user("write", v.id);
    const other = await user("write", v.id);
    const curator = await user("curate", v.id);
    const ids = async () => (await writer.call("GET", "/api/review?limit=500")).json().map((x: { id: string }) => x.id);

    // a document with little text is in the list until a person accepts it
    const id = (await writer.upload(v.id, [{ name: "poco.md", data: Buffer.from(`# Poco ${run}

Testo.`) }])).json().sources[0].id;
    await waitLevel(writer, id, 2);
    await sql!`update sources set meta = meta || '{"warnings": ["little_text"]}' where id = ${id}`;
    expect(await ids()).toContain(id);
    expect((await writer.call("POST", `/api/sources/${id}/reviewed`)).statusCode).toBe(200);
    expect(await ids()).not.toContain(id);
    expect((await writer.call("POST", `/api/sources/${id}/reingest`)).statusCode).toBe(200);
    const [m] = await sql!<{ reviewed: boolean }[]>`select meta ? 'reviewed' as reviewed from sources where id = ${id}`;
    expect(m!.reviewed).toBe(false); // a new result is reviewed again
    await waitLevel(writer, id, 2);

    // a link: only link sources have an address; a refused URL leaves the source as it is
    expect((await writer.call("POST", `/api/sources/${id}/relink`, { url: "https://example.com/" })).statusCode).toBe(400);
    await sql!`update sources set origin = 'link', path = 'https://example.com/x' where id = ${id}`;
    const bad = await writer.call("POST", `/api/sources/${id}/relink`, { url: "http://192.168.1.10:8000/v1/models" });
    expect(bad.statusCode).toBe(400);
    expect((await writer.call("GET", `/api/sources/${id}`)).statusCode).toBe(200);

    // delete: the uploader or a curator; refused while another page cites the document
    expect((await other.call("DELETE", `/api/sources/${id}`)).statusCode).toBe(403);
    const cite = await new PageStore(sql!, { minTokens: 1 }).upsert({ vaultId: v.id, markdown: `---
title: Cita ${run}
---
Vedi.^[${id}#c1]` });
    const cited = await writer.call("DELETE", `/api/sources/${id}`);
    expect(cited.statusCode).toBe(409);
    expect(cited.json().error.message).toContain(`Cita ${run}`);
    await new PageStore(sql!).delete(cite.page.id);
    expect((await writer.call("POST", `/api/sources/${id}/compile`)).statusCode).toBe(200);
    const done = await waitLevel(writer, id, 3);
    const [blob] = await sql!<{ sha: string }[]>`select sha256 as sha from sources where id = ${id}`;
    const del = await curator.call("DELETE", `/api/sources/${id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ sources: 1, pages: 1 });
    expect((await writer.call("GET", `/api/sources/${id}`)).statusCode).toBe(404);
    expect(await sql!`select 1 from pages where id = ${done.compiledPage}`).toHaveLength(0);
    expect(await sql!`select 1 from chunks where source_id = ${id}`).toHaveLength(0);
    expect(await store!.blobs.has(v.id, blob!.sha)).toBe(false);
    const [a] = await sql!<{ action: string }[]>`select action from audit_log where resource = ${id} and action = 'source.delete'`;
    expect(a).toBeTruthy();
  });

  db()("server-sent events report status changes of the caller's vaults", async () => {
    const v = await vaults!.create({ kind: "space", slug: `srcsse-${run}`, name: "SSE" });
    const writer = await user("write", v.id);
    await app!.listen({ port: 0, host: "127.0.0.1" });
    const port = (app!.server.address() as { port: number }).port;
    const events: string[] = [];
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { cookie: writer.cookie } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d: string) => events.push(d));
    });
    await new Promise((r) => setTimeout(r, 300));
    await writer.upload(v.id, [{ name: "e.txt", data: Buffer.from("evento " + run) }]);
    const parsed = () =>
      events
        .join("")
        .split("\n\n")
        .filter((b) => b.startsWith("event: source"))
        .map((b) => JSON.parse(b.split("\ndata: ")[1]!) as { vault: string; level: number; status: string });
    for (let i = 0; i < 100 && !parsed().some((e) => e.level === 2); i++) await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    const got = parsed();
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((e) => e.vault === v.id)).toBe(true); // only the caller's vaults
    expect(got.map((e) => e.status)).toEqual(expect.arrayContaining(["stored", "indexed", "embedded"]));
  });
});
