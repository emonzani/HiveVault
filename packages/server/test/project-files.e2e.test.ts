// Repository files of a project vault (vault-docs.conf of the mod): an API account with the
// scope "projects" writes one source per file path, a new version replaces the old source,
// a file no longer listed is deleted, and nothing else changes.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AuthService } from "@cb/auth";
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
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-pf-e2e-"));
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
      name: `ingest-pf-${run}`,
    })
  : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50 }).register(task!) : undefined;
const ingest = sql ? new IngestService(sql, store!, engine!, task!, undefined, { compileUploads: false }) : undefined;
await engine?.start();
const app = sql ? await buildApp({ sql, auth: auth!, vaults: vaults!, search: search!, ingest: ingest!, secureCookies: false, loginRateLimitPerMin: 10_000 }) : undefined;
afterAll(async () => {
  await app?.close();
  await engine?.stop();
  await auth?.stop();
  dispatcher.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

async function key(scopes: ("projects" | "read")[]) {
  const p = await auth!.principals.createApiAccount({ name: `pf-${run}-${Math.random().toString(36).slice(2, 6)}`, scopes, clearance: 1 });
  const { key: k } = await auth!.apiKeys.issue(p.id);
  return (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
    app!.inject({ method, url, headers: { authorization: `Bearer ${k}` }, ...(body ? { payload: body as object } : {}) });
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Waits until no task of the vault's sources runs: a running source cannot be deleted. */
async function idle(vaultId: string) {
  for (let i = 0; i < 1200; i++) {
    const [r] = await sql!<{ n: number }[]>`select count(*)::int as n from sources s join tasks t on t.id = s.task_id where s.vault_id = ${vaultId} and t.status in ('queued', 'running', 'sleeping', 'waiting')`;
    if (!r!.n) return;
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

describe("repository files of a project vault", () => {
  db()("writes, replaces and deletes one source per path", { timeout: 180_000 }, async () => {
    const call = await key(["projects"]);
    const slug = `pf-${run}`;
    const v = (await call("POST", "/api/projects", { slug, name: "PF" })).json();
    const url = `/api/projects/${slug}/files`;

    const w1 = await call("PUT", url, { path: "docs/guida.md", content: b64("# Guida\n\nPrima versione.\n"), commit: "5906a70edaa13b65" });
    expect(w1.statusCode, w1.body).toBe(200);
    expect(w1.json()).toMatchObject({ path: "docs/guida.md", created: true, removed: 0 });
    // the same bytes again change nothing but the commit they were seen at
    expect((await call("PUT", url, { path: "docs/guida.md", content: b64("# Guida\n\nPrima versione.\n"), commit: "77aa00ff" })).json()).toMatchObject({ created: false, removed: 0 });
    expect((await call("GET", url)).json().files).toEqual([expect.objectContaining({ path: "docs/guida.md", sourceId: w1.json().sourceId, commit: "77aa00ff" })]);

    // a new version replaces the old source
    await idle(v.id);
    const w2 = await call("PUT", url, { path: "docs/guida.md", content: b64("# Guida\n\nSeconda versione.\n") });
    expect(w2.json()).toMatchObject({ created: true, removed: 1 });
    const files = (await call("GET", url)).json().files;
    expect(files).toHaveLength(1);
    expect(files[0].sourceId).toBe(w2.json().sourceId);

    // a file no longer listed goes
    await idle(v.id);
    expect((await call("DELETE", `${url}?path=${encodeURIComponent("docs/guida.md")}`)).json()).toMatchObject({ removed: 1 });
    expect((await call("GET", url)).json().files).toEqual([]);
    const [audit] = await sql!`select data from audit_log where action = 'project.file.delete' and resource = ${v.id} order by id desc limit 1`;
    expect(audit!.data).toMatchObject({ path: "docs/guida.md", removed: 1 });
  });

  db()("the bytes of a source the account cannot read: a generic answer, nothing written", { timeout: 180_000 }, async () => {
    const call = await key(["projects"]);
    const slug = `pf3-${run}`;
    const v = (await call("POST", "/api/projects", { slug, name: "PF3" })).json();
    const url = `/api/projects/${slug}/files`;
    const w1 = await call("PUT", url, { path: "docs/piano.md", content: b64("# Piano\n\nPrima versione.\n") });
    expect(w1.json()).toMatchObject({ created: true });
    const secret = "# Piano\n\nVersione riservata.\n";
    const { source: hidden } = await store!.create(Buffer.from(secret, "utf8"), { vaultId: v.id, name: "riservato.md", origin: "upload", classification: 2 }, "system");

    await idle(v.id);
    const w2 = await call("PUT", url, { path: "docs/piano.md", content: b64(secret), commit: "abcdef12" });
    expect(w2.statusCode).toBe(200);
    expect(w2.json()).toEqual({ path: "docs/piano.md", removed: 0, duplicate: true });
    expect((await call("GET", url)).json().files).toEqual([expect.objectContaining({ path: "docs/piano.md", sourceId: w1.json().sourceId })]);
    expect(await store!.get(hidden.id)).toMatchObject({ path: null, meta: {}, compile: false, taskId: null });
  });

  db()("refuses paths out of the repository and vaults of other accounts", async () => {
    const call = await key(["projects"]);
    const slug = `pf2-${run}`;
    await call("POST", "/api/projects", { slug, name: "PF2" });
    for (const p of ["../x.md", "/etc/passwd", "a/../b.md", "C:/x.md", "a\\b.md"]) {
      expect((await call("PUT", `/api/projects/${slug}/files`, { path: p, content: b64("x") })).statusCode, p).toBe(400);
    }
    const stranger = await key(["projects"]);
    expect((await stranger("PUT", `/api/projects/${slug}/files`, { path: "a.md", content: b64("x") })).statusCode).toBe(403);
    expect((await stranger("GET", `/api/projects/${slug}/files`)).statusCode).toBe(403);
  });
});
