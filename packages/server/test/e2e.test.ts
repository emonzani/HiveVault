import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { AuthService, base32Decode, signLogin, totp } from "@cb/auth";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL } from "@cb/models";
import { ulid } from "@cb/shared";
import { buildApp } from "../src/app.ts";
import { SoftAuthenticator } from "../../auth/test/soft-authenticator.ts";

const ORIGIN = "http://localhost:3700";
const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();

const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "HiveVault", origins: [ORIGIN] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const app: FastifyInstance | undefined = sql
  ? await buildApp({ sql, auth: auth!, vaults: vaults!, search: new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }), secureCookies: false, loginRateLimitPerMin: 10_000 }) // all inject() calls share one IP
  : undefined;
afterAll(async () => {
  await app?.close();
  await auth?.stop();
  dispatcher.stop();
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

// ---------------------------------------------------------------------------
// Client helpers: a cookie jar per user, CSRF header on state-changing calls
// ---------------------------------------------------------------------------
class Client {
  cookies: Record<string, string> = {};
  csrf = "";
  bearer = "";
  async call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, opts: { csrf?: boolean } = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (Object.keys(this.cookies).length) headers.cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    if (method !== "GET" && opts.csrf !== false && this.csrf) headers["x-cb-csrf"] = this.csrf;
    const res = await app!.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    for (const c of res.cookies as { name: string; value: string }[]) {
      if (c.value) this.cookies[c.name] = c.value;
      else delete this.cookies[c.name];
    }
    const body = res.headers["content-type"]?.toString().includes("json") ? res.json() : null;
    if (body?.csrf) this.csrf = body.csrf;
    return res;
  }
}

/** Activates an account through the API and returns a logged-in client and the TOTP secret. */
async function activate(code: string): Promise<{ c: Client; secret: Buffer }> {
  const c = new Client();
  const start = await c.call("POST", "/api/auth/enroll/start", { code });
  expect(start.statusCode).toBe(200);
  expect(start.json().qrSvg).toMatch(/^<svg/);
  const secret = base32Decode(start.json().secret);
  const conf = await c.call("POST", "/api/auth/enroll/confirm", { code, totp: totp(secret) });
  expect(conf.statusCode).toBe(200);
  expect(conf.json().recoveryCodes).toHaveLength(10);
  return { c, secret };
}

async function newAdmin(): Promise<Client> {
  const p = await auth!.principals.createUser({ username: `adm-${run}-${Math.random().toString(36).slice(2, 6)}`, displayName: "Admin", role: "admin", clearance: 3 });
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  return (await activate(code)).c;
}

async function vaultWithPage(slug: string, title: string, body: string) {
  const v = await vaults!.create({ kind: "space", slug: `${slug}-${run}`, name: slug });
  const r = await new PageStore(sql!, { minTokens: 1 }).upsert({ vaultId: v.id, markdown: `---\ntitle: ${title}\n---\n${body}` });
  await new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL }).run(v.id);
  return { v, pageId: r.page.id };
}

describe("HTTP basics", () => {
  db()("health, security headers, Italian validation errors, 404", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    const bad = await app!.inject({ method: "POST", url: "/api/auth/login/totp", payload: { username: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/^Dati non validi/);
    expect((await app!.inject({ method: "GET", url: "/api/nulla" })).json().error.code).toBe("not_found");
    expect((await app!.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });
});

describe("login methods over HTTP", () => {
  db()("admin creates a user; the user activates TOTP, logs out and logs in again", async () => {
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/users", { username: `cognomebbb-${run}`, displayName: "Nome CognomeBBB", email: "nome.cognomebbb@example.com" });
    expect(created.statusCode).toBe(201);
    const { c, secret } = await activate(created.json().enrollment.code);
    const me = await c.call("GET", "/api/auth/me");
    expect(me.json().principal.name).toBe(`cognomebbb-${run}`);
    expect(me.json().isAdmin).toBe(false);
    expect((await c.call("POST", "/api/auth/logout")).statusCode).toBe(200);
    expect((await c.call("GET", "/api/auth/me")).statusCode).toBe(401);
    const login = await c.call("POST", "/api/auth/login/totp", { username: `cognomebbb-${run}`, code: totp(secret, Date.now() + 30_000) });
    expect(login.statusCode).toBe(200);
    expect(c.cookies.cb_session).toBeTruthy();
    const cookie = (login.headers["set-cookie"] as string[]).find((h) => h.startsWith("cb_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  db()("passkey: register from the profile, then log in without username", async () => {
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/users", { username: `cognomeiii-${run}`, displayName: "Nome CognomeIII" });
    const { c } = await activate(created.json().enrollment.code);
    const device = new SoftAuthenticator(ORIGIN, "localhost");
    const opts = (await c.call("POST", "/api/me/passkeys/options")).json();
    const reg = await c.call("POST", "/api/me/passkeys", { challengeId: opts.challengeId, response: device.register(opts.options), name: "Portatile" });
    expect(reg.statusCode).toBe(200);
    await c.call("POST", "/api/auth/logout");

    const fresh = new Client();
    const o = (await fresh.call("POST", "/api/auth/passkey/options", {})).json();
    const login = await fresh.call("POST", "/api/auth/passkey/login", { challengeId: o.challengeId, response: device.authenticate(o.options) });
    expect(login.statusCode).toBe(200);
    expect((await fresh.call("GET", "/api/auth/me")).json().principal.name).toBe(`cognomeiii-${run}`);
  });

  db()("signature: the admin registers a public key, the user logs in with the challenge", async () => {
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/users", { username: `edge-${run}`, displayName: "Sensore magazzino" });
    const id = created.json().principal.id;
    const kp = generateKeyPairSync("ed25519");
    const added = await admin.call("POST", `/api/admin/principals/${id}/public-keys`, { pem: kp.publicKey.export({ type: "spki", format: "pem" }), name: "Edge 1" });
    expect(added.statusCode).toBe(201);
    const c = new Client();
    const ch = (await c.call("GET", `/api/auth/challenge?username=edge-${run}`)).json();
    const signed = signLogin(kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string, `edge-${run}`, ch.nonce);
    const login = await c.call("POST", "/api/auth/challenge", { username: `edge-${run}`, challengeId: ch.challengeId, ...signed });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toHaveLength(43); // for clients without a cookie jar (CLI, edge)
    expect((await c.call("GET", "/api/auth/me")).json().principal.id).toBe(id);
  });

  db()("recovery code login over HTTP", async () => {
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/users", { username: `rec-${run}`, displayName: "Recupero" });
    const c = new Client();
    const code = created.json().enrollment.code;
    const secret = base32Decode((await c.call("POST", "/api/auth/enroll/start", { code })).json().secret);
    const codes = (await c.call("POST", "/api/auth/enroll/confirm", { code, totp: totp(secret) })).json().recoveryCodes as string[];
    const other = new Client();
    const r = await other.call("POST", "/api/auth/login/recovery", { username: `rec-${run}`, code: codes[3] });
    expect(r.statusCode).toBe(200);
    expect(r.json().recoveryCodesLeft).toBe(9);
  });
});

describe("CSRF and admin safeguards", () => {
  db()("a cookie session must send the CSRF token on state-changing calls", async () => {
    const admin = await newAdmin();
    const no = await admin.call("POST", "/api/admin/users", { username: `csrf-${run}`, displayName: "X" }, { csrf: false });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.message).toMatch(/CSRF/);
    const yes = await admin.call("POST", "/api/admin/users", { username: `csrf-${run}`, displayName: "X" });
    expect(yes.statusCode).toBe(201);
  });

  db()("an admin cannot suspend, demote or delete itself; suspension ends the sessions", async () => {
    const admin = await newAdmin();
    const me = (await admin.call("GET", "/api/auth/me")).json().principal.id;
    expect((await admin.call("PATCH", `/api/admin/principals/${me}`, { status: "suspended" })).statusCode).toBe(409);
    expect((await admin.call("PATCH", `/api/admin/principals/${me}`, { role: "member" })).statusCode).toBe(409);
    expect((await admin.call("DELETE", `/api/admin/principals/${me}`)).statusCode).toBe(409);
    const created = await admin.call("POST", "/api/admin/users", { username: `susp-${run}`, displayName: "Sospeso" });
    const { c } = await activate(created.json().enrollment.code);
    expect((await c.call("GET", "/api/auth/me")).statusCode).toBe(200);
    await admin.call("PATCH", `/api/admin/principals/${created.json().principal.id}`, { status: "suspended" });
    expect((await c.call("GET", "/api/auth/me")).statusCode).toBe(401);
  });

  db()("members cannot use the admin API", async () => {
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/users", { username: `memb-${run}`, displayName: "Membro" });
    const { c } = await activate(created.json().enrollment.code);
    expect((await c.call("GET", "/api/admin/principals")).statusCode).toBe(403);
    expect((await c.call("POST", "/api/admin/users", { username: "x-" + run, displayName: "x" })).statusCode).toBe(403);
  });
});

describe("vault isolation over REST", () => {
  db()("a member sees only granted vaults: search, read and neighbors", async () => {
    const a = await vaultWithPage("iso-a", "Contratto Alpi", "Contratto Company example 2 con 250 postazioni. Vedi [[Segreto Beta]].");
    const b = await vaultWithPage("iso-b", "Segreto Beta", "Contratto riservato Beta con 900 postazioni.");
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/users", { username: `iso-${run}`, displayName: "Iso" });
    const userId = created.json().principal.id;
    expect((await admin.call("PUT", "/api/admin/grants", { principalId: userId, vaultId: a.v.id, permission: "read" })).statusCode).toBe(200);
    const { c } = await activate(created.json().enrollment.code);

    const vs = (await c.call("GET", "/api/vaults")).json() as { id: string }[];
    expect(vs.map((v) => v.id)).toEqual([a.v.id]);
    const s1 = (await c.call("POST", "/api/search", { query: "contratto postazioni" })).json();
    expect(s1.hits.length).toBeGreaterThan(0);
    expect(s1.hits.every((h: { vaultId: string }) => h.vaultId === a.v.id)).toBe(true);
    const s2 = (await c.call("POST", "/api/search", { query: "Segreto Beta 900", vaults: [b.v.id] })).json();
    expect(s2.hits).toEqual([]);
    expect((await c.call("GET", `/api/pages/${b.pageId}`)).statusCode).toBe(404);
    expect((await c.call("GET", `/api/pages/${a.pageId}`)).statusCode).toBe(200);
    const g = (await c.call("GET", `/api/pages/${a.pageId}/neighbors`)).json();
    expect(g.nodes.map((n: { id: string }) => n.id)).toEqual([a.pageId]);

    // the admin revokes the grant: access ends at the next request
    await admin.call("DELETE", `/api/admin/grants/${userId}/${a.v.id}`);
    expect((await c.call("GET", `/api/pages/${a.pageId}`)).statusCode).toBe(404);
  });

  db()("an API account with read scope: bearer key, its grants only, clearance, no admin, audited reads", async () => {
    const a = await vaultWithPage("api-a", "Listino Atlas", "Listino prezzi Company example 2 per postazione.");
    const secret = await vaultWithPage("api-s", "Stipendi", "Stipendi del personale.");
    await sql!`update pages set classification = 2 where id = ${secret.pageId}`; // riservato
    await sql!`update chunks set classification = 2 where page_id = ${secret.pageId}`;
    const admin = await newAdmin();
    const created = await admin.call("POST", "/api/admin/api-accounts", { name: `agent-${run}`, scopes: ["read"], clearance: 1 });
    expect(created.statusCode).toBe(201);
    const apiId = created.json().principal.id;
    await admin.call("PUT", "/api/admin/grants", { principalId: apiId, vaultId: a.v.id, permission: "admin" });
    await admin.call("PUT", "/api/admin/grants", { principalId: apiId, vaultId: secret.v.id, permission: "read" });

    const bot = new Client();
    bot.bearer = created.json().key;
    const s = (await bot.call("POST", "/api/search", { query: "listino stipendi personale" })).json();
    expect(s.hits.map((h: { id: string }) => h.id)).toContain(a.pageId);
    expect(s.hits.map((h: { id: string }) => h.id)).not.toContain(secret.pageId); // riservato > clearance interno
    expect((await bot.call("GET", `/api/pages/${secret.pageId}`)).statusCode).toBe(404);
    expect((await bot.call("GET", `/api/pages/${a.pageId}`)).statusCode).toBe(200);
    expect((await bot.call("GET", "/api/admin/principals")).statusCode).toBe(403);
    // no CSRF for bearer keys (no ambient credential)
    expect((await bot.call("POST", "/api/search", { query: "listino" }, { csrf: false })).statusCode).toBe(200);

    await auth!.audit.flush();
    const trail = (await admin.call("GET", `/api/admin/audit?principalId=${apiId}`)).json() as { action: string; data: { classification?: number } }[];
    expect(trail.map((t) => t.action)).toEqual(expect.arrayContaining(["search", "page.read"]));
    expect(trail.find((t) => t.action === "page.read")!.data.classification).toBe(1);

    // a revoked key stops working at once
    const keyId = created.json().keyId;
    await admin.call("DELETE", `/api/admin/principals/${apiId}/api-keys/${keyId}`);
    expect((await bot.call("POST", "/api/search", { query: "listino" })).statusCode).toBe(401);
  });
});

describe("rate limiting", () => {
  db()("limits login attempts per IP", async () => {
    const limited = await buildApp({ sql: sql!, auth: auth!, vaults: vaults!, search: new SearchEngine(sql!, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }), secureCookies: false, loginRateLimitPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await limited.inject({ method: "GET", url: `/api/auth/challenge?username=rl-${run}`, remoteAddress: "10.9.9.9" })).statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[4]).toBe(429);
    await limited.close();
  });
});
