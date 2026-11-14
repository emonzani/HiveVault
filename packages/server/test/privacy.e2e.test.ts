// Privacy over HTTP (docs/sicurezza/privacy.md): "personale" content is read only by the owner of the
// personal vault, never by administrators; teams; account deletion with transfer to a team;
// rectification is in hive.e2e; audit log append-only with a hash chain; nightly upkeep.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import JSZip from "jszip";
import { AuthService, base32Decode, totp, verifyAuditChain } from "@cb/auth";
import { FsBlobStore } from "@cb/blobs";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { globalUpkeep, syncClaims } from "@cb/hive";
import { Compiler, defineIngestTask, IngestService, SourceStore } from "@cb/ingest";
import { MetricsService } from "@cb/metrics";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL } from "@cb/models";
import { parseFile } from "@cb/parsers";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { buildApp } from "../src/app.ts";
import { Settings } from "../src/ops/settings.ts";

const DIMS = 16;
const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-privacy-"));
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS }));
const auth = sql ? new AuthService(sql, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: ["http://localhost"] } }) : undefined;
const vaults = sql ? new VaultStore(sql, DIMS) : undefined;
const pages = sql ? new PageStore(sql, { minTokens: 1 }) : undefined;
const search = sql ? new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL }) : undefined;
const store = sql ? new SourceStore(sql, new FsBlobStore(path.join(tmp, "blobs"), randomBytes(32))) : undefined;
const task = sql
  ? defineIngestTask({
      store: store!,
      parse: (d, n) => parseFile(d, n),
      indexer: () => new EmbeddingIndexer(sql, dispatcher, { model: MOCK_EMBED_MODEL }),
      compiler: new Compiler(sql, store!, new PageStore(sql), search!, dispatcher, { useModel: "never" }),
      chunk: { minTokens: 1 },
      name: `ingest-privacy-${run}`,
    })
  : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50 }).register(task!) : undefined;
const ingest = sql ? new IngestService(sql, store!, engine!, task!, undefined, { compileUploads: false }) : undefined;
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
await engine?.start();
const app: FastifyInstance | undefined = sql
  ? await buildApp({
      sql,
      auth: auth!,
      vaults: vaults!,
      search: search!,
      ingest: ingest!,
      secureCookies: false,
      loginRateLimitPerMin: 10_000,
      ops: { metrics: metricsService!, engine: engine!, pages: pages!, settings: settings!, dataDir: tmp },
    })
  : undefined;
afterAll(async () => {
  await app?.close();
  await engine?.stop();
  await metricsService?.stop();
  await auth?.stop();
  dispatcher.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

class Client {
  cookie = "";
  csrf = "";
  id = "";
  call(method: string, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { cookie: this.cookie };
    if (method !== "GET") h["x-cb-csrf"] = this.csrf;
    return app!.inject({ method: method as "GET", url, headers: h, ...(payload !== undefined ? { payload: payload as string } : {}) });
  }
}

async function user(role: "admin" | "member", clearance = 3): Promise<Client> {
  const p = await auth!.principals.createUser({ username: `p${run}-${Math.random().toString(36).slice(2, 7)}`, displayName: "U", role, clearance });
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  const st = await auth!.totp.startEnrollment(code);
  const r = await auth!.enrollConfirm(code, totp(base32Decode(st.secretBase32)));
  const c = new Client();
  c.cookie = `cb_session=${r.session.token}`;
  c.csrf = r.session.csrf;
  c.id = p.id;
  return c;
}

/** A personal vault of `owner`, made by `admin` over the API. */
async function personalVault(admin: Client, owner: Client, slug: string): Promise<{ id: string; defaultClassification: number }> {
  const r = await admin.call("POST", "/api/admin/vaults", { kind: "cell", slug: `${slug}-${run}`, name: slug, owner: `user:${owner.id}` });
  expect(r.statusCode).toBe(201);
  return r.json();
}

describe("personale", () => {
  db()("only the owner reads personal content; administrators, grantees and exports never do", async () => {
    const admin = await user("admin");
    const owner = await user("member");
    const colleague = await user("member");
    const v = await personalVault(admin, owner, "pers");
    // privacy by default: a personal vault starts "personale"
    expect(v.defaultClassification).toBe(4);
    await auth!.access.grant(colleague.id, v.id, "write", null);

    const mine = await owner.call("POST", `/api/vaults/${v.id}/pages`, { title: `Diario ${run}`, body: `# Diario ${run}\n\nVisita medica ${run}.`, classification: 4 });
    expect(mine.statusCode).toBe(201);
    // the default makes a page personal: shared content needs a level chosen by the owner
    const byDefault = await owner.call("POST", `/api/vaults/${v.id}/pages`, { title: `Appunto ${run}` });
    expect((await sql!<{ c: number }[]>`select classification as c from pages where id = ${byDefault.json().id}`)[0]).toEqual({ c: 4 });
    const shared = await owner.call("POST", `/api/vaults/${v.id}/pages`, { title: `Progetto ${run}`, body: `# Progetto ${run}\n\nRiunione ${run}.`, classification: 1 });
    // only the owner may use "personale"
    expect((await colleague.call("POST", `/api/vaults/${v.id}/pages`, { title: `Altro ${run}`, classification: 4 })).statusCode).toBe(403);
    expect((await admin.call("POST", `/api/vaults/${v.id}/pages`, { title: `Altro ${run}`, classification: 4 })).statusCode).toBe(403);

    expect((await owner.call("GET", `/api/pages/${mine.json().id}/full`)).statusCode).toBe(200);
    for (const c of [admin, colleague]) {
      expect((await c.call("GET", `/api/pages/${mine.json().id}/full`)).statusCode).toBe(404);
      expect((await c.call("GET", `/api/pages/${shared.json().id}/full`)).statusCode).toBe(200);
      const hits = (await c.call("POST", "/api/search", { query: `visita medica ${run}`, vaults: [v.id] })).json().hits as { id: string }[];
      expect(hits.map((h) => h.id)).not.toContain(mine.json().id);
      expect((await c.call("PUT", `/api/pages/${mine.json().id}`, { markdown: "# x", baseVersion: 1 })).statusCode).toBe(404);
    }
    const ownHits = (await owner.call("POST", "/api/search", { query: `visita medica ${run}`, vaults: [v.id] })).json().hits as { id: string }[];
    expect(ownHits.map((h) => h.id)).toContain(mine.json().id);

    // personal documents: hidden from the console, not changed, not deleted by administrators
    const up = await ingest!.upload(v.id, Buffer.from(`Referto ${run}: tutto bene.`), `referto-${run}.txt`, owner.id, { classification: 4 });
    const listed = (await admin.call("GET", `/api/admin/sources?vault=${v.id}`)).json() as { id: string }[];
    expect(listed.map((s) => s.id)).not.toContain(up.source.id);
    expect((await admin.call("PATCH", `/api/admin/sources/${up.source.id}`, { classification: 1 })).statusCode).toBe(404);
    expect((await admin.call("DELETE", `/api/admin/sources/${up.source.id}`)).statusCode).toBe(404);
    expect((await admin.call("GET", `/api/sources/${up.source.id}`)).statusCode).toBe(404);
    expect((await admin.call("GET", `/api/sources/${up.source.id}/original`)).statusCode).toBe(404);
    expect((await admin.call("POST", "/api/admin/pages/merge", { keep: shared.json().id, drop: mine.json().id })).statusCode).toBe(400);

    // exports and checkpoints leave personal pages out; a restore never removes them
    const exp = await admin.call("POST", `/api/admin/vaults/${v.id}/export`);
    const zip = await JSZip.loadAsync(exp.rawPayload);
    const text = (await Promise.all(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.async("string")))).join("\n");
    expect(text).toContain(`Riunione ${run}`);
    expect(text).not.toContain(`Visita medica ${run}`);
    const cp = (await admin.call("POST", `/api/admin/vaults/${v.id}/checkpoints`, { name: "prima" })).json();
    expect(cp.pages).toBe(1);
    expect((await admin.call("POST", `/api/admin/checkpoints/${cp.id}/restore`)).statusCode).toBe(200);
    expect(await sql!`select 1 from pages where id = ${mine.json().id}`).toHaveLength(1);

    // the owner of a vault with personal content never changes
    expect((await admin.call("PATCH", `/api/admin/vaults/${v.id}`, { owner: `user:${colleague.id}` })).statusCode).toBe(409);
    // "personale" outside a personal vault does not exist
    const team = await admin.call("POST", "/api/admin/vaults", { kind: "cell", slug: `t-${run}`, name: "T", defaultClassification: 4 });
    expect(team.statusCode).toBe(400);
    const plain = (await admin.call("POST", "/api/admin/vaults", { kind: "cell", slug: `t2-${run}`, name: "T2" })).json();
    expect(plain.defaultClassification).toBe(1);
    await expect(pages!.upsert({ vaultId: plain.id, markdown: `---\ntitle: X ${run}\nclassification: personale\n---\nx` })).rejects.toThrow(/personale/);

    // personal pages are never promoted: no claims
    await pages!.upsert({ vaultId: v.id, id: mine.json().id, markdown: `---\ntitle: Diario ${run}\nclassification: personale\n---\n## Stato attuale\n\n- Medico: Rossi ^[${up.source.id}]\n` });
    await syncClaims(sql!, { vaultIds: [v.id] });
    expect(await sql!`select 1 from claims where page_id = ${mine.json().id}`).toHaveLength(0);
  });
});

describe("teams and account deletion", () => {
  db()("team grants reach members; a deleted user's personal content goes, the rest passes to the team", async () => {
    const admin = await user("admin");
    const leaving = await user("member");
    const member = await user("member");
    const t1 = (await admin.call("POST", "/api/admin/teams", { name: `vendite${run}`, displayName: "Vendite" })).json().principal;
    const t2 = (await admin.call("POST", "/api/admin/teams", { name: `acquisti${run}`, displayName: "Acquisti" })).json().principal;
    expect(t1.kind).toBe("team");
    // a team never logs in and has no API keys
    expect((await admin.call("POST", `/api/admin/principals/${t1.id}/api-keys`, {})).statusCode).toBe(404);
    // members: users only, many teams each
    expect((await admin.call("PUT", `/api/admin/teams/${t1.id}/members/${t2.id}`)).statusCode).toBe(400);
    expect((await admin.call("PUT", `/api/admin/teams/${t1.id}/members/${member.id}`)).statusCode).toBe(200);
    expect((await admin.call("GET", `/api/admin/teams/${t1.id}/members`)).json().map((m: { id: string }) => m.id)).toEqual([member.id]);

    // a grant to the team reaches its members
    const shared = (await admin.call("POST", "/api/admin/vaults", { kind: "space", slug: `sp-${run}`, name: "Spazio" })).json();
    expect((await member.call("GET", `/api/vaults/${shared.id}/folders`)).statusCode).toBe(403);
    await admin.call("PUT", "/api/admin/grants", { principalId: t1.id, vaultId: shared.id, permission: "read" });
    expect((await member.call("GET", `/api/vaults/${shared.id}/folders`)).statusCode).toBe(200);

    // the leaving user: one personal vault with personal and shared content
    const v = await personalVault(admin, leaving, "via");
    const priv = (await leaving.call("POST", `/api/vaults/${v.id}/pages`, { title: `Privato ${run}`, classification: 4 })).json();
    const work = (await leaving.call("POST", `/api/vaults/${v.id}/pages`, { title: `Lavoro ${run}`, classification: 1 })).json();
    const doc = await ingest!.upload(v.id, Buffer.from(`Busta paga ${run}`), `busta-${run}.txt`, leaving.id, { classification: 4 });
    const blob = path.join(tmp, "blobs", v.id, doc.source.sha256.slice(0, 2), doc.source.sha256.slice(2, 4), doc.source.sha256);

    // no team: the administrator must choose one; two teams: the same
    expect((await admin.call("DELETE", `/api/admin/principals/${leaving.id}`)).statusCode).toBe(409);
    await admin.call("PUT", `/api/admin/teams/${t1.id}/members/${leaving.id}`);
    await admin.call("PUT", `/api/admin/teams/${t2.id}/members/${leaving.id}`);
    expect((await admin.call("DELETE", `/api/admin/principals/${leaving.id}`)).statusCode).toBe(409);
    expect((await admin.call("DELETE", `/api/admin/principals/${leaving.id}?team=${leaving.id}`)).statusCode).toBe(400);
    const del = await admin.call("DELETE", `/api/admin/principals/${leaving.id}?team=${t1.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ team: { id: t1.id }, vaults: [{ vault: v.id, action: "transferred", personal: { pages: 1, sources: 1 } }] });
    expect(await sql!`select 1 from pages where id = ${priv.id}`).toHaveLength(0);
    expect(await sql!`select 1 from sources where id = ${doc.source.id}`).toHaveLength(0);
    await expect(import("node:fs/promises").then((f) => f.stat(blob))).rejects.toThrow();
    expect(await sql!`select 1 from pages where id = ${work.id}`).toHaveLength(1);
    // the default "personale" of the vault becomes "riservato" with the team
    expect((await sql!<{ owner: string; dc: number }[]>`select owner, default_classification as dc from vaults where id = ${v.id}`)[0]).toEqual({ owner: `team:${t1.id}`, dc: 2 });
    // the members of the team now work in the vault
    expect((await member.call("GET", `/api/pages/${work.id}/full`)).json()).toMatchObject({ canWrite: true });

    // a team that owns vaults is not deleted
    expect((await admin.call("DELETE", `/api/admin/principals/${t1.id}`)).statusCode).toBe(409);
    // a user whose vault holds only personal content: the vault goes, no team needed
    const solo = await user("member");
    const sv = await personalVault(admin, solo, "solo");
    await solo.call("POST", `/api/vaults/${sv.id}/pages`, { title: `Note ${run}`, classification: 4 });
    expect((await admin.call("DELETE", `/api/admin/principals/${solo.id}`)).json()).toMatchObject({ vaults: [{ vault: sv.id, action: "deleted" }] });
    expect(await sql!`select 1 from vaults where id = ${sv.id}`).toHaveLength(0);
  });
});

describe("audit log", () => {
  db()("append-only, hash chain over security events, read events apart", async () => {
    const admin = await user("admin");
    await auth!.audit.writeNow({ principalId: admin.id, action: "admin.test", resource: run });
    await auth!.audit.writeNow({ principalId: admin.id, action: "page.read", resource: run });
    const [sec] = await sql!<{ id: string; seq: string | null }[]>`select id::text, seq::text from audit_log where action = 'admin.test' and resource = ${run}`;
    const [read] = await sql!<{ id: string; seq: string | null }[]>`select id::text, seq::text from audit_log where action = 'page.read' and resource = ${run}`;
    expect(sec!.seq).not.toBeNull();
    expect(read!.seq).toBeNull();
    await expect(sql!`update audit_log set resource = 'x' where id = ${sec!.id}`).rejects.toThrow(/append-only/);
    await expect(sql!`delete from audit_log where id = ${sec!.id}`).rejects.toThrow(/6 months/);
    await expect(sql!`truncate audit_log`).rejects.toThrow(/append-only/);
    expect((await verifyAuditChain(sql!)).broken).toBeNull();
    expect((await admin.call("GET", "/api/admin/audit/verify")).json()).toMatchObject({ broken: null });

    // read events go after their retention; failed logins after 24 hours
    await sql!`insert into auth_failures (username, at) values (${`gone${run}`}, now() - interval '2 days'), (${`kept${run}`}, now())`;
    const up = await globalUpkeep(sql!, { readDays: 30 });
    expect(up.chain.seq).toBeGreaterThan(0);
    expect(await sql!`select 1 from auth_failures where username = ${`gone${run}`}`).toHaveLength(0);
    expect(await sql!`select 1 from auth_failures where username = ${`kept${run}`}`).toHaveLength(1);
    expect(await sql!`select 1 from audit_log where id = ${read!.id}`).toHaveLength(1);
    // a change made behind the triggers breaks the chain
    await sql!.begin(async (tx) => {
      await tx`alter table audit_log disable trigger audit_log_no_update`;
      await tx`update audit_log set resource = 'cambiato' where id = ${sec!.id}`;
      const r = await verifyAuditChain(tx as unknown as Sql);
      expect(r.broken).toMatchObject({ seq: Number(sec!.seq), reason: "hash" });
      throw new Error("rollback");
    }).catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
    expect((await verifyAuditChain(sql!)).broken).toBeNull();
  });
});
