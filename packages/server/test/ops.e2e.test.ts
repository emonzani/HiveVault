// Console operations over HTTP: metrics, stats panels, Prometheus, tasks, sources, models,
// settings, backup. Every stats query runs against the real schema.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import JSZip from "jszip";
import { AuthService, base32Decode, totp } from "@cb/auth";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MetricsService } from "@cb/metrics";
import { LlamaEndpoint, MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL, type ModelsRuntime } from "@cb/models";
import { loadModelsConfig, metrics, ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { buildApp } from "../src/app.ts";
import { ModelsAdmin } from "../src/ops/models.ts";
import { IMPORT_LIMITS } from "../src/routes/ops.ts";
import { Settings } from "../src/ops/settings.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const dataDir = mkdtempSync(path.join(os.tmpdir(), "cb-ops-"));
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
// a remote endpoint "of .env" on a private address that does not answer (it stays down)
const ENV_EMBED = "http://192.168.250.250:9";
await dispatcher.addEndpoint(new LlamaEndpoint({ id: "remote-embed-1", kind: "embed", origin: "remote", url: ENV_EMBED, timeoutMs: 500 })).catch(() => {});
const envCfg = { ...loadModelsConfig(), embed: { ...loadModelsConfig().embed, remoteUrls: [ENV_EMBED] } };
const runtime: ModelsRuntime = { dispatcher, supervisors: [], stop: async () => {} };
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: ["http://localhost"] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const settings = sql
  ? new Settings(sql, {
      dream: { window: "22:00-06:00", minutes: 120, tokens: 1000, compilePerNight: 5, useModel: false },
      notice: { text: "" },
      defaults: { classification: 1 },
      privacy: { readRetentionDays: 30, emailIngest: true },
      "models.local": { threads: 4, schedule: "always", offHours: "19:00-07:00" },
      "models.remote": [],
      "models.overrides": {},
    })
  : undefined;
const metricsService = sql ? new MetricsService(sql) : undefined;
const engine = sql ? new TaskEngine(sql) : undefined;
const TOKEN = `scrape-${run}`;
const app: FastifyInstance | undefined = sql
  ? await buildApp({
      sql,
      auth: auth!,
      vaults: vaults!,
      search: new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }),
      secureCookies: false,
      loginRateLimitPerMin: 10_000,
      ops: { metrics: metricsService!, engine: engine!, pages: pages!, models: new ModelsAdmin(runtime, settings!, null, undefined, envCfg), settings: settings!, dataDir, metricsToken: TOKEN },
    })
  : undefined;
afterAll(async () => {
  await app?.close();
  await metricsService?.stop();
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
async function user(role: "admin" | "member"): Promise<Client> {
  const p = await auth!.principals.createUser({ username: `o${run}-${Math.random().toString(36).slice(2, 7)}`, displayName: "U", role, clearance: 3 });
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  const st = await auth!.totp.startEnrollment(code);
  const r = await auth!.enrollConfirm(code, totp(base32Decode(st.secretBase32)));
  const c = new Client();
  c.cookie = `cb_session=${r.session.token}`;
  c.csrf = r.session.csrf;
  return c;
}

describe("ops API", () => {
  db()("admins only; every stats panel answers", async () => {
    await settings!.load();
    const admin = await user("admin");
    const member = await user("member");
    expect((await member.call("GET", "/api/admin/stats/overview")).statusCode).toBe(403);
    expect((await member.call("GET", "/api/admin/tasks")).statusCode).toBe(403);
    for (const name of ["slow-queries", "partitions", "coverage", "ingest-errors", "backlog", "top-pages", "dream", "dream-steps", "hive", "hive-cells", "memory-lists", "security", "overview"]) {
      const r = await admin.call("GET", `/api/admin/stats/${name}`);
      expect(r.statusCode, `${name}: ${r.body}`).toBe(200);
    }
    expect((await admin.call("GET", "/api/admin/stats/nope")).statusCode).toBe(404);
  });

  db()("metrics query and Prometheus scrape", async () => {
    const admin = await user("admin");
    metrics.inc(`ops_test_${run}`, { k: "a" }, 3);
    await metricsService!.tick(new Date());
    const cat = (await admin.call("GET", "/api/admin/metrics/catalog")).json() as { name: string }[];
    expect(cat.some((c) => c.name === `ops_test_${run}`)).toBe(true);
    const now = Date.now();
    const q = await admin.call("POST", "/api/admin/metrics/query", {
      from: new Date(now - 3600_000).toISOString(),
      to: new Date(now + 60_000).toISOString(),
      queries: [{ id: "a", name: `ops_test_${run}`, agg: "sum" }],
    });
    expect(q.statusCode).toBe(200);
    const res = q.json().results[0];
    expect(res.id).toBe("a");
    expect(res.series[0].points.reduce((s: number, p: [number, number]) => s + p[1], 0)).toBe(3);
    expect((await admin.call("POST", "/api/admin/metrics/query", { from: new Date(now).toISOString(), to: new Date(now - 1).toISOString(), queries: [] })).statusCode).toBe(400);

    // the scraper token works only at /metrics; without it, a session of an administrator
    const scrape = await app!.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.body).toContain(`cb_ops_test_${run}_total{k="a"} 3`);
    expect((await app!.inject({ method: "GET", url: "/api/admin/tasks", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(401);
    expect((await app!.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect((await admin.call("GET", "/metrics")).statusCode).toBe(200);
  });

  db()("tasks: list, cancel, retry", async () => {
    const admin = await user("admin");
    const id = ulid();
    await sql!`insert into tasks (id, name, version, status, phase, input, state) values (${id}, ${`ops-${run}`}, 1, 'queued', 'start', '{}', '{}')`;
    const list = (await admin.call("GET", `/api/admin/tasks?name=ops-${run}`)).json();
    expect(list.items).toHaveLength(1);
    expect((await admin.call("PATCH", `/api/admin/tasks/${id}`, { priority: 0, runNow: true })).statusCode).toBe(200);
    expect((await sql!<{ priority: number }[]>`select priority from tasks where id = ${id}`)[0]!.priority).toBe(0);
    expect((await admin.call("PATCH", `/api/admin/tasks/${id}`, { priority: 12 })).statusCode).toBe(400);
    expect((await admin.call("POST", `/api/admin/tasks/${id}/retry`)).statusCode).toBe(409);
    expect((await admin.call("POST", `/api/admin/tasks/${id}/cancel`)).statusCode).toBe(200);
    expect((await admin.call("POST", `/api/admin/tasks/${id}/cancel`)).statusCode).toBe(409);
    expect((await admin.call("PATCH", `/api/admin/tasks/${id}`, { priority: 1 })).statusCode).toBe(409); // concluded
    expect((await admin.call("POST", `/api/admin/tasks/${id}/retry`)).statusCode).toBe(200);
    expect((await admin.call("GET", `/api/admin/tasks/${id}`)).json().task).toMatchObject({ status: "queued" });
    const [a] = await sql!`select action from audit_log where resource = ${id} and action = 'admin.task.cancel' limit 1`;
    expect(a).toMatchObject({ action: "admin.task.cancel" });
  });

  db()("settings, notice text, default classification of new vaults", async () => {
    const admin = await user("admin");
    const member = await user("member");
    expect((await member.call("PUT", "/api/admin/settings/notice", { text: "x" })).statusCode).toBe(403);
    expect((await admin.call("PUT", "/api/admin/settings/dream", { window: "nope" })).statusCode).toBe(400);
    const d = await admin.call("PUT", "/api/admin/settings/dream", { window: "23:00-05:00", minutes: 60, tokens: 5000, compilePerNight: 3, useModel: true });
    expect(d.statusCode).toBe(200);
    expect(settings!.get("dream").window).toBe("23:00-05:00");
    await admin.call("PUT", "/api/admin/settings/notice", { text: `Avviso ${run}` });
    expect((await member.call("GET", "/api/notice-text")).json()).toEqual({ text: `Avviso ${run}` });
    await admin.call("PUT", "/api/admin/settings/defaults", { classification: 2 });
    const v = await admin.call("POST", "/api/admin/vaults", { kind: "cell", slug: `od-${run}`, name: "D" });
    expect(v.json().defaultClassification).toBe(2);
    expect((await admin.call("GET", "/api/admin/settings")).json().dream.minutes).toBe(60);
    await admin.call("PUT", "/api/admin/settings/defaults", { classification: 1 });
  });

  db()("models: snapshot, test, remote endpoints of the console", async () => {
    const admin = await user("admin");
    const snap = (await admin.call("GET", "/api/admin/models")).json();
    expect(snap.endpoints.length).toBeGreaterThan(0);
    const id = snap.endpoints[0].id;
    expect((await admin.call("POST", `/api/admin/models/${id}/test`)).json()).toMatchObject({ ok: true });
    expect((await admin.call("POST", "/api/admin/models/remote", { kind: "embed", url: "ftp://x" })).statusCode).toBe(400);
    // invariant 1: a public address would send document text out of the company network
    const pub = await admin.call("POST", "/api/admin/models/remote", { kind: "embed", url: "http://8.8.8.8:8080" });
    expect(pub.statusCode).toBe(400);
    expect(pub.json().error.message).toContain("rete aziendale");
    const lan = await admin.call("POST", "/api/admin/models/remote", { kind: "embed", url: "http://192.168.250.250:9" });
    expect(lan.statusCode).toBe(200);
    const moved = await admin.call("PATCH", `/api/admin/models/remote/${lan.json().id}`, { url: "http://192.168.250.251:9" });
    expect(moved.json()).toMatchObject({ id: lan.json().id, url: "http://192.168.250.251:9" });
    expect((await admin.call("PATCH", `/api/admin/models/remote/${lan.json().id}`, { url: "http://8.8.4.4:9" })).statusCode).toBe(400);
    expect((await admin.call("GET", "/api/admin/models")).json().remote).toEqual([{ id: lan.json().id, kind: "embed", url: "http://192.168.250.251:9" }]);
    expect((await admin.call("DELETE", `/api/admin/models/remote/${lan.json().id}`)).statusCode).toBe(200);

    // an endpoint of .env: a new address is stored as an override; the .env address removes it
    const env = await admin.call("PATCH", "/api/admin/models/remote/remote-embed-1", { url: "http://192.168.250.252:9" });
    expect(env.statusCode, env.body).toBe(200);
    let msnap = (await admin.call("GET", "/api/admin/models")).json();
    expect(msnap.overrides).toEqual({ "remote-embed-1": "http://192.168.250.252:9" });
    expect(msnap.endpoints.find((e: { id: string }) => e.id === "remote-embed-1").url).toBe("http://192.168.250.252:9");
    expect((await admin.call("PATCH", "/api/admin/models/remote/remote-embed-1", { url: "http://8.8.8.8:9" })).statusCode).toBe(400);
    expect((await admin.call("PATCH", "/api/admin/models/remote/remote-embed-1", { url: ENV_EMBED })).statusCode).toBe(200);
    msnap = (await admin.call("GET", "/api/admin/models")).json();
    expect(msnap.overrides).toEqual({});
    // mocks and local processes are not remote endpoints
    expect((await admin.call("PATCH", "/api/admin/models/remote/mock-embed", { url: "http://192.168.250.253:9" })).statusCode).toBe(400);
    expect((await admin.call("POST", "/api/admin/models/local/embed/start")).statusCode).toBe(400);
    expect((await admin.call("DELETE", `/api/admin/models/remote/${id}`)).statusCode).toBe(400);
  });

  db()("sources: delete with children and chunks; vault export and import", async () => {
    const admin = await user("admin");
    const v = await vaults!.create({ kind: "cell", slug: `os-${run}`, name: "S" });
    const parent = ulid();
    const child = ulid();
    await sql!`insert into sources (id, vault_id, sha256, name, mime, size, status) values (${parent}, ${v.id}, ${"a".repeat(64)}, 'p.zip', 'application/zip', 10, 'ready')`;
    await sql!`insert into sources (id, vault_id, sha256, name, mime, size, status, parent_id) values (${child}, ${v.id}, ${"b".repeat(64)}, 'c.txt', 'text/plain', 5, 'ready', ${parent})`;
    const list = (await admin.call("GET", `/api/admin/sources?vault=${v.slug}`)).json();
    expect(list.find((s: { id: string }) => s.id === parent).children).toBe(1);

    // edit: title and classification; the child, the chunks and the compiled page follow
    const page = await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Compilata ${run}\nclassification: interno\n---\nTesto compilato dalla sorgente.` });
    await sql!`update sources set compiled_page = ${page.page.id} where id = ${parent}`;
    await sql!`insert into chunks (vault_id, id, source_id, ord, text, tokens, hash, classification) values (${v.id}, ${`${child}:0`}, ${child}, 0, 'testo', 1, 'h', 1)`;
    const ed = await admin.call("PATCH", `/api/admin/sources/${parent}`, { title: `  Contratti ${run}  `, classification: 2 });
    expect(ed.statusCode, ed.body).toBe(200);
    expect(ed.json()).toMatchObject({ classification: { from: 1, to: 2, sources: 2 }, pagesRaised: [page.page.id] });
    expect(await sql!`select id, title, classification from sources where vault_id = ${v.id} order by id`).toEqual(
      [parent, child].sort().map((id) => ({ id, title: id === parent ? `Contratti ${run}` : null, classification: 2 })),
    );
    expect((await sql!`select classification from chunks where source_id = ${child}`)[0]).toEqual({ classification: 2 });
    expect((await sql!`select classification, version from pages where id = ${page.page.id}`)[0]).toEqual({ classification: 2, version: 2 });
    // lowering the source never lowers the page
    expect((await admin.call("PATCH", `/api/admin/sources/${parent}`, { classification: 0 })).json()).not.toHaveProperty("pagesRaised");
    expect((await sql!`select classification from pages where id = ${page.page.id}`)[0]).toEqual({ classification: 2 });
    expect((await admin.call("PATCH", `/api/admin/sources/${parent}`, {})).statusCode).toBe(400);
    const [a] = await sql!`select data from audit_log where action = 'admin.source.update' and resource = ${parent} order by id limit 1`;
    expect(a!.data).toMatchObject({ classification: { from: 1, to: 2 } });
    // vault: owner can be set and removed
    // a team owner is a team principal, stored by id
    const opsTeam = await auth!.principals.createTeam({ name: `ops${run}`, displayName: "Ops" });
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `team:ops${run}` })).json().owner).toBe(`team:${opsTeam.id}`);
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `team:nobody${run}` })).statusCode).toBe(400);
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: null })).json().owner).toBeNull();
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: "nessuno" })).statusCode).toBe(400);
    // a user owner is stored by principal id, also when the console sends the username
    const owner = await auth!.principals.createUser({ username: `own${run}`, displayName: "Owner", role: "member", clearance: 1 });
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `user:own${run}` })).json().owner).toBe(`user:${owner.id}`);
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `user:${owner.id}` })).json().owner).toBe(`user:${owner.id}`);
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `user:nobody${run}` })).statusCode).toBe(400);
    const made = await admin.call("POST", "/api/admin/vaults", { kind: "cell", slug: `own-${run}`, name: "Cella", owner: `user:own${run}` });
    expect(made.json().owner).toBe(`user:${owner.id}`);
    expect((await admin.call("GET", "/api/admin/vaults")).json().find((x: { id: string }) => x.id === made.json().id).ownerLabel).toBe("Owner");
    // owner suggestions: users and teams by name, other kinds from the owners in use
    expect((await admin.call("GET", `/api/admin/owners?kind=user&q=own${run}`)).json()).toEqual([{ value: owner.id, label: "Owner", hint: `own${run}` }]);
    const sales = await auth!.principals.createTeam({ name: `vendite${run}`, displayName: "Vendite" });
    expect((await admin.call("GET", `/api/admin/owners?kind=team&q=vendite${run}`)).json()).toEqual([{ value: sales.id, label: "Vendite", hint: `vendite${run}` }]);
    await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `project:alfa${run}` });
    expect((await admin.call("GET", `/api/admin/owners?kind=project&q=alfa${run}`)).json()).toEqual([{ value: `alfa${run}`, label: `alfa${run}` }]);
    expect((await admin.call("GET", `/api/admin/owners?kind=altro&q=xx`)).statusCode).toBe(400);
    // grants of one account or one vault, with their names
    await admin.call("PUT", "/api/admin/grants", { principalId: owner.id, vaultId: v.id, permission: "read" });
    const byUser = (await admin.call("GET", `/api/admin/grants?principalId=${owner.id}`)).json();
    expect(byUser).toEqual([expect.objectContaining({ vaultId: v.id, permission: "read", principalName: "Owner", vaultName: v.name, vaultKind: "cell" })]);
    expect((await admin.call("GET", `/api/admin/grants?vaultId=${v.id}`)).json().map((g: { principalId: string }) => g.principalId)).toEqual([owner.id]);
    const del = await admin.call("DELETE", `/api/admin/sources/${parent}`);
    expect(del.json()).toMatchObject({ deleted: 2 });
    expect(await sql!`select 1 from sources where vault_id = ${v.id}`).toHaveLength(0);

    await pages!.upsert({ vaultId: v.id, markdown: `---\ntitle: Pagina ${run}\n---\nTesto da salvare.` });
    const exp = await admin.call("POST", `/api/admin/vaults/${v.id}/export`);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-type"]).toBe("application/zip");
    const zip = await JSZip.loadAsync(exp.rawPayload);
    expect(Object.keys(zip.files).some((f) => f.endsWith(".md"))).toBe(true);
    expect((await admin.call("GET", "/api/admin/backup")).json().exports.length).toBeGreaterThan(0);

    const target = await vaults!.create({ kind: "cell", slug: `oi-${run}`, name: "I" });
    const boundary = `----cb${run}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      exp.rawPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const imp = await app!.inject({
      method: "POST",
      url: `/api/admin/vaults/${target.id}/import`,
      headers: { cookie: admin.cookie, "x-cb-csrf": admin.csrf, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(imp.statusCode, imp.body).toBe(200);
    const [p] = await sql!`select title from pages where vault_id = ${target.id} and title like 'Pagina %'`;
    expect(p).toMatchObject({ title: `Pagina ${run}` });

    // zip bomb: a tiny archive that inflates beyond the limit of one file is refused
    const bomb = new JSZip();
    bomb.file("a.md", Buffer.alloc(IMPORT_LIMITS.fileBytes + 1024, 0x61));
    const small = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    expect(small.length).toBeLessThan(200_000);
    const r = await app!.inject({
      method: "POST",
      url: `/api/admin/vaults/${target.id}/import`,
      headers: { cookie: admin.cookie, "x-cb-csrf": admin.csrf, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\nContent-Type: application/zip\r\n\r\n`),
        small,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("troppo grande");

    // an import that rewrites most of a vault asks first; confirmed, a checkpoint comes first
    const big = await vaults!.create({ kind: "cell", slug: `om-${run}`, name: "M" });
    const many = new JSZip();
    for (let i = 0; i < 8; i++) {
      const w = await pages!.upsert({ vaultId: big.id, markdown: `---\ntitle: Voce ${i} ${run}\n---\nTesto ${i}.` });
      // like an export: file named by title, page id in the frontmatter (half of them), or the same path
      if (i % 2) many.file(`notes/Voce ${i}.md`, `---\nid: ${w.page.id}\ntitle: Voce ${i} ${run}\n---\nTesto ${i} riscritto.`);
      else many.file(w.page.path, `---\ntitle: Voce ${i} ${run}\n---\nTesto ${i} riscritto.`);
    }
    const manyZip = await many.generateAsync({ type: "nodebuffer" });
    const send = (q: string) =>
      app!.inject({
        method: "POST",
        url: `/api/admin/vaults/${big.id}/import${q}`,
        headers: { cookie: admin.cookie, "x-cb-csrf": admin.csrf, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="m.zip"\r\nContent-Type: application/zip\r\n\r\n`),
          manyZip,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    const held = await send("");
    expect(held.statusCode).toBe(409);
    expect(held.json().error.message).toContain("riscrive 8 delle 8 pagine");
    expect((await sql!`select body from pages where vault_id = ${big.id} and title = ${`Voce 0 ${run}`}`)[0]!.body).not.toContain("riscritto");
    const done = await send("?confirm=true");
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ updated: 8, checkpoint: expect.stringMatching(/^chk_/) });

    // checkpoints: list, restore (the import goes away), delete
    const cps = (await admin.call("GET", `/api/admin/vaults/${big.slug}/checkpoints`)).json();
    expect(cps[0]).toMatchObject({ id: done.json().checkpoint, name: "Prima dell'import", kind: "auto", pages: 8 });
    const manual = await admin.call("POST", `/api/admin/vaults/${big.id}/checkpoints`, { name: "Dopo l'import" });
    expect(manual.json()).toMatchObject({ kind: "manual", pages: 8 });
    const back = await admin.call("POST", `/api/admin/checkpoints/${done.json().checkpoint}/restore`);
    expect(back.json()).toMatchObject({ restored: 8, removed: 0, skipped: [] });
    expect((await sql!`select body from pages where vault_id = ${big.id} and title = ${`Voce 0 ${run}`}`)[0]!.body).not.toContain("riscritto");
    expect((await admin.call("DELETE", `/api/admin/checkpoints/${manual.json().id}`)).statusCode).toBe(204);
    expect((await admin.call("POST", `/api/admin/checkpoints/${manual.json().id}/restore`)).statusCode).toBe(404);
    const [audit] = await sql!`select data from audit_log where action = 'admin.checkpoint.restore' and resource = ${done.json().checkpoint}`;
    expect(audit!.data).toMatchObject({ restored: 8 });
  });
});
