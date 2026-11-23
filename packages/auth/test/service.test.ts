import { generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { ulid } from "@cb/shared";
import { Access, apiCap, AuthError, AuthService, base32Decode, ipAllowed, sha256hex, signLogin, totp } from "../src/index.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => readFileSync(path.join(here, "fixtures", f), "utf8");
const sql: Sql | undefined = await setupTestDb();
const ORIGIN = "http://localhost:5310";
const auth = sql
  ? new AuthService(sql, {
      masterKey: randomBytes(32),
      webauthn: { rpId: "localhost", rpName: "HiveVault", origins: [ORIGIN] },
      clientCaPems: [fx("ca.pem")],
    })
  : undefined;
afterAll(async () => {
  await auth?.stop();
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();
let n = 0;
const uname = () => `u${run}-${n++}`;

/** Creates a user and completes the TOTP enrollment. Returns the user and its secret. */
async function enrolledUser(role: "admin" | "member" = "member") {
  const p = await auth!.principals.createUser({ username: uname(), displayName: "Test", role });
  const { code } = await auth!.totp.createEnrollment(p.id, null);
  const start = await auth!.totp.startEnrollment(code);
  const secret = base32Decode(start.secretBase32);
  const res = await auth!.enrollConfirm(code, totp(secret));
  return { p, secret, recovery: res.recoveryCodes, enrollCode: code };
}

describe("TOTP login", () => {
  db()("enrolls, logs in, refuses reuse of the same code and of the enrollment code", async () => {
    const { p, secret, enrollCode } = await enrolledUser();
    await expect(auth!.totp.startEnrollment(enrollCode)).rejects.toThrow(/scaduto/);
    // the enrollment code consumed the current step: the next login needs a new step
    const next = totp(secret, Date.now() + 30_000);
    const r = await auth!.loginTotp(p.name, next);
    expect(r.principal.id).toBe(p.id);
    expect(r.session.token).toHaveLength(43);
    await expect(auth!.loginTotp(p.name, next)).rejects.toBeInstanceOf(AuthError);
  });

  db()("locks the user out after 5 failures and says the same thing for unknown users", async () => {
    const { p } = await enrolledUser();
    const err1 = await auth!.loginTotp(p.name, "000000").catch((e) => e);
    const err2 = await auth!.loginTotp("nessuno-" + run, "000000").catch((e) => e);
    expect(err1.message).toBe(err2.message);
    for (let i = 0; i < 4; i++) await auth!.loginTotp(p.name, "000000").catch(() => {});
    const locked = await auth!.loginTotp(p.name, "000000").catch((e) => e);
    expect(locked.code).toBe("locked");
    expect(locked.retryAfterMs).toBeGreaterThan(0);
    const audit = await auth!.audit.query({ action: "login.totp", outcome: "denied", limit: 20 });
    expect(audit.some((a) => a.principalId === p.id)).toBe(true);
  });

  db()("concurrent wrong codes: only the first 5 reach verification, the rest are locked", async () => {
    const { p } = await enrolledUser();
    const errs = await Promise.all(Array.from({ length: 20 }, () => auth!.loginTotp(p.name, "000000").catch((e) => e)));
    expect(errs.filter((e) => e.code === "invalid_credentials")).toHaveLength(5);
    expect(errs.filter((e) => e.code === "locked")).toHaveLength(15);
    expect((await auth!.lockout.check(p.name)).failures).toBe(5);
  });

  db()("an error during verification is not recorded as a failure", async () => {
    const { p } = await enrolledUser();
    const spy = vi.spyOn(auth!.totp, "verify").mockRejectedValueOnce(new Error("db down"));
    try {
      await expect(auth!.loginTotp(p.name, "000000")).rejects.toThrow("db down");
    } finally {
      spy.mockRestore();
    }
    expect((await auth!.lockout.check(p.name)).failures).toBe(0);
  });

  db()("recovery codes work once", async () => {
    const { p, recovery } = await enrolledUser();
    expect(recovery).toHaveLength(10);
    await auth!.loginRecovery(p.name, recovery[0]!.toUpperCase());
    await expect(auth!.loginRecovery(p.name, recovery[0]!)).rejects.toBeInstanceOf(AuthError);
    expect(await auth!.totp.remainingRecoveryCodes(p.id)).toBe(9);
  });

  db()("stores recovery codes under the keyed hash, not as plain SHA-256", async () => {
    const { p, recovery } = await enrolledUser();
    const rows = await sql!<{ code_hash: string }[]>`select code_hash from recovery_codes where principal_id = ${p.id}`;
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.code_hash.startsWith("k1:"))).toBe(true);
    const plain = recovery.map((c) => sha256hex(`${p.id}:${c.toUpperCase().replace(/[^A-Z0-9]/g, "")}`));
    expect(rows.some((r) => plain.some((h) => r.code_hash.includes(h)))).toBe(false);
  });

  db()("recovery codes stored as plain SHA-256 work once, before and after the upgrade", async () => {
    const { p } = await enrolledUser();
    const plain = (c: string) => sha256hex(`${p.id}:${c}`);
    await sql!`delete from recovery_codes where principal_id = ${p.id}`;
    for (const c of ["AAAABBBB", "CCCCDDDD", "EEEEFFFF"]) await sql!`insert into recovery_codes (principal_id, code_hash) values (${p.id}, ${plain(c)})`;
    await sql!`update recovery_codes set used_at = now() where principal_id = ${p.id} and code_hash = ${plain("EEEEFFFF")}`;
    // before the upgrade
    await auth!.loginRecovery(p.name, "aaaa-bbbb");
    await expect(auth!.loginRecovery(p.name, "aaaa-bbbb")).rejects.toBeInstanceOf(AuthError);
    // the upgrade rewrites the rows once and keeps their used state
    await auth!.totp.upgradeRecoveryCodes();
    await auth!.totp.upgradeRecoveryCodes();
    const rows = await sql!<{ code_hash: string; used: boolean }[]>`select code_hash, used_at is not null as used from recovery_codes where principal_id = ${p.id}`;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.code_hash.startsWith("k1:"))).toBe(true);
    expect(rows.filter((r) => r.used)).toHaveLength(2);
    expect(await auth!.totp.remainingRecoveryCodes(p.id)).toBe(1);
    await expect(auth!.loginRecovery(p.name, "aaaa-bbbb")).rejects.toBeInstanceOf(AuthError);
    await expect(auth!.loginRecovery(p.name, "eeee-ffff")).rejects.toBeInstanceOf(AuthError);
    await auth!.loginRecovery(p.name, "cccc-dddd");
    await expect(auth!.loginRecovery(p.name, "cccc-dddd")).rejects.toBeInstanceOf(AuthError);
    expect(await auth!.totp.remainingRecoveryCodes(p.id)).toBe(0);
  });

  db()("a suspended user cannot log in and loses its sessions", async () => {
    const { p, secret } = await enrolledUser();
    const s = await auth!.loginTotp(p.name, totp(secret, Date.now() + 30_000));
    expect(await auth!.authenticate({ sessionToken: s.session.token })).not.toBeNull();
    await auth!.principals.update(p.id, { status: "suspended" });
    expect(await auth!.authenticate({ sessionToken: s.session.token })).toBeNull();
    await expect(auth!.loginTotp(p.name, totp(secret, Date.now() + 60_000))).rejects.toBeInstanceOf(AuthError);
  });
});

describe("sessions", () => {
  db()("idle and absolute expiry, revocation", async () => {
    const short = new AuthService(sql!, { masterKey: randomBytes(32), webauthn: { rpId: "localhost", rpName: "x", origins: [ORIGIN] }, session: { idleMs: 1000, maxMs: 60_000 } });
    const { p } = await enrolledUser();
    const s = await short.sessions.create(p.id, "totp");
    expect(await short.sessions.resolve(s.token)).not.toBeNull();
    await sql!`update sessions set last_seen_at = now() - interval '2 seconds' where id = ${s.id}`;
    expect(await short.sessions.resolve(s.token)).toBeNull(); // idle
    const s2 = await short.sessions.create(p.id, "totp");
    await sql!`update sessions set expires_at = now() - interval '1 second' where id = ${s2.id}`;
    expect(await short.sessions.resolve(s2.token)).toBeNull(); // absolute
    const s3 = await short.sessions.create(p.id, "totp");
    expect(await short.sessions.revokeAllFor(p.id)).toBeGreaterThanOrEqual(1);
    expect(await short.sessions.resolve(s3.token)).toBeNull();
    // only the hash is stored
    const [row] = await sql!`select id from sessions where id = ${s3.id}`;
    expect((row as { id: string }).id).not.toBe(s3.token);
    await short.stop();
  });
});

describe("API keys", () => {
  db()("issue, verify, IP allow-list, expiry and revocation", async () => {
    const a = await auth!.principals.createApiAccount({ name: `agent-${run}`, scopes: ["read"], allowedIps: ["10.0.0.0/8"] });
    const { id, key } = await auth!.apiKeys.issue(a.id, "test");
    expect(key).toMatch(/^cb_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    expect(await auth!.authenticate({ bearer: key, ip: "10.1.2.3" })).toMatchObject({ via: "apikey" });
    expect(await auth!.authenticate({ bearer: key, ip: "192.168.1.5" })).toBeNull();
    expect(await auth!.authenticate({ bearer: key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"), ip: "10.1.2.3" })).toBeNull();
    await auth!.principals.update(a.id, { expiresAt: new Date(Date.now() - 1000) });
    expect(await auth!.authenticate({ bearer: key, ip: "10.1.2.3" })).toBeNull();
    await auth!.principals.update(a.id, { expiresAt: null });
    expect(await auth!.apiKeys.revoke(a.id, id)).toBe(true);
    expect(await auth!.authenticate({ bearer: key, ip: "10.1.2.3" })).toBeNull();
  });

  it("matches IPv4, IPv6 and IPv4-mapped addresses against CIDRs", () => {
    expect(ipAllowed("10.0.0.7", ["10.0.0.0/24"])).toBe(true);
    expect(ipAllowed("::ffff:10.0.0.7", ["10.0.0.0/24"])).toBe(true);
    expect(ipAllowed("10.0.1.7", ["10.0.0.0/24"])).toBe(false);
    expect(ipAllowed("fd00::1", ["fd00::/8"])).toBe(true);
    expect(ipAllowed("1.2.3.4", null)).toBe(true);
  });
});

describe("signature login", () => {
  for (const kind of ["ed25519", "ec"] as const) {
    db()(`logs in with a ${kind} key; the nonce works once`, async () => {
      const { p } = await enrolledUser();
      const kp = kind === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
      await auth!.signature.addKey(p.id, kp.publicKey.export({ type: "spki", format: "pem" }) as string);
      const ch = await auth!.signature.challenge(p.name);
      const signed = signLogin(kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string, ORIGIN, p.name, ch.nonce);
      const r = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signed });
      expect(r.principal.id).toBe(p.id);
      await expect(auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signed })).rejects.toBeInstanceOf(AuthError);
    });
  }

  db()("refuses a signature for another user, a stale timestamp, and an unknown key", async () => {
    const { p } = await enrolledUser();
    const other = await enrolledUser();
    const kp = generateKeyPairSync("ed25519");
    await auth!.signature.addKey(p.id, kp.publicKey.export({ type: "spki", format: "pem" }) as string);
    const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    let ch = await auth!.signature.challenge(other.p.name);
    await expect(auth!.loginSignature({ username: other.p.name, challengeId: ch.challengeId, ...signLogin(priv, ORIGIN, other.p.name, ch.nonce) })).rejects.toBeInstanceOf(AuthError);
    ch = await auth!.signature.challenge(p.name);
    await expect(auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signLogin(priv, ORIGIN, p.name, ch.nonce, Math.floor(Date.now() / 1000) - 600) })).rejects.toBeInstanceOf(AuthError);
    const stranger = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    ch = await auth!.signature.challenge(p.name);
    await expect(auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signLogin(stranger, ORIGIN, p.name, ch.nonce) })).rejects.toBeInstanceOf(AuthError);
  });

  db()("accepts a client certificate of the company CA and refuses a self-signed one", async () => {
    const { p } = await enrolledUser();
    await expect(auth!.signature.addKey(p.id, fx("rogue.pem"))).rejects.toThrow(/CA aziendale/);
    // the fixture certificate is the same in every run: remove the copy of a previous run
    const spki = new X509Certificate(fx("client.pem")).publicKey.export({ type: "spki", format: "der" });
    await sql!`delete from public_keys where fingerprint = ${sha256hex(spki)}`;
    const key = await auth!.signature.addKey(p.id, fx("client.pem"), "Certificato aziendale");
    expect(key.kind).toBe("x509");
    expect(key.notAfter!.getFullYear()).toBeGreaterThan(2030);
    const ch = await auth!.signature.challenge(p.name);
    const r = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signLogin(fx("client-key.pem"), ORIGIN, p.name, ch.nonce) });
    expect(r.principal.id).toBe(p.id);
  });

  db()("binds the signature to the origin of this server: another server cannot relay it", async () => {
    const { p } = await enrolledUser();
    const kp = generateKeyPairSync("ed25519");
    await auth!.signature.addKey(p.id, kp.publicKey.export({ type: "spki", format: "pem" }) as string);
    const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    // the client talked to a relaying server: it signed that server's origin
    let ch = await auth!.signature.challenge(p.name);
    const relayed = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signLogin(priv, "https://relay.example", p.name, ch.nonce) }).catch((e) => e);
    expect(relayed.code).toBe("invalid_credentials");
    ch = await auth!.signature.challenge(p.name);
    const told = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, origin: "https://relay.example", ...signLogin(priv, "https://relay.example", p.name, ch.nonce) }).catch((e) => e);
    expect(told.code).toBe("origin_mismatch");
    const audit = await auth!.audit.query({ action: "login.signature.origin", principalId: p.id, limit: 5 });
    expect(audit[0]?.data).toMatchObject({ origin: "https://relay.example" });
    // path, trailing slash and case do not change the origin
    ch = await auth!.signature.challenge(p.name);
    const r = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...signLogin(priv, "HTTP://LocalHost:5310/api/", p.name, ch.nonce) });
    expect(r.principal.id).toBe(p.id);
  });

  db()("refuses the old v1 message with its own error, without a session or a lockout count", async () => {
    const { p } = await enrolledUser();
    const kp = generateKeyPairSync("ed25519");
    await auth!.signature.addKey(p.id, kp.publicKey.export({ type: "spki", format: "pem" }) as string);
    const v1 = (key: typeof kp.privateKey, nonce: string) => {
      const ts = Math.floor(Date.now() / 1000);
      return { ts, signature: cryptoSign(null, Buffer.from(`cb-auth-v1|${p.name}|${nonce}|${ts}`), key).toString("base64") };
    };
    for (let i = 0; i < 6; i++) {
      const ch = await auth!.signature.challenge(p.name);
      const e = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...v1(kp.privateKey, ch.nonce) }).catch((x) => x);
      expect(e.code).toBe("signature_outdated");
    }
    expect((await auth!.lockout.check(p.name)).failures).toBe(0);
    const audit = await auth!.audit.query({ action: "login.signature.outdated", principalId: p.id, limit: 10 });
    expect(audit).toHaveLength(6);
    expect(audit[0]).toMatchObject({ outcome: "denied", resource: p.name });
    // a v1 signature of a key that is not registered is an ordinary failure
    const ch = await auth!.signature.challenge(p.name);
    const e = await auth!.loginSignature({ username: p.name, challengeId: ch.challengeId, ...v1(generateKeyPairSync("ed25519").privateKey, ch.nonce) }).catch((x) => x);
    expect(e.code).toBe("invalid_credentials");
    expect((await auth!.lockout.check(p.name)).failures).toBe(1);
  });

  db()("answers a challenge for an unknown user too (no user enumeration)", async () => {
    const ch = await auth!.signature.challenge(`nessuno-${run}`);
    expect(ch.nonce).toHaveLength(43);
  });
});

describe("passkeys", () => {
  db()("registers a passkey and logs in with it, with and without username", async () => {
    const { p } = await enrolledUser();
    const device = new SoftAuthenticator(ORIGIN, "localhost");
    const reg = await auth!.passkeys.registrationOptions(p);
    const info = await auth!.passkeys.verifyRegistration(p.id, reg.challengeId, device.register(reg.options), "Portatile");
    expect(info.name).toBe("Portatile");

    const discoverable = await auth!.passkeys.authenticationOptions();
    const r1 = await auth!.loginPasskey(discoverable.challengeId, device.authenticate(discoverable.options));
    expect(r1.principal.id).toBe(p.id);

    const named = await auth!.passkeys.authenticationOptions(p.name);
    expect(named.options.allowCredentials?.map((c) => c.id)).toEqual([device.id]);
    const r2 = await auth!.loginPasskey(named.challengeId, device.authenticate(named.options));
    expect(r2.principal.id).toBe(p.id);
  });

  db()("refuses a response from another origin and a replayed challenge", async () => {
    const { p } = await enrolledUser();
    const device = new SoftAuthenticator(ORIGIN, "localhost");
    const reg = await auth!.passkeys.registrationOptions(p);
    await auth!.passkeys.verifyRegistration(p.id, reg.challengeId, device.register(reg.options));
    const o = await auth!.passkeys.authenticationOptions();
    await expect(auth!.loginPasskey(o.challengeId, device.authenticate(o.options, "https://phishing.example"))).rejects.toBeInstanceOf(AuthError);
    const o2 = await auth!.passkeys.authenticationOptions();
    const resp = device.authenticate(o2.options);
    await auth!.loginPasskey(o2.challengeId, resp);
    await expect(auth!.loginPasskey(o2.challengeId, resp)).rejects.toBeInstanceOf(AuthError);
  });
});

describe("authorization", () => {
  db()("admins see every vault; members see grants and their own cell; API scopes cap the grant", async () => {
    const [v1] = await sql!<{ id: string }[]>`
      insert into vaults (id, kind, slug, name, chunks_partition) values (${`vlt_a${run}`}, 'space', ${`az-a-${run}`}, 'A', ${`chunks_ta${run}`}) returning id`;
    const [v2] = await sql!<{ id: string }[]>`
      insert into vaults (id, kind, slug, name, chunks_partition) values (${`vlt_b${run}`}, 'space', ${`az-b-${run}`}, 'B', ${`chunks_tb${run}`}) returning id`;
    const admin = await auth!.principals.createUser({ username: uname(), displayName: "Admin", role: "admin" });
    const member = await auth!.principals.createUser({ username: uname(), displayName: "Membro" });
    const [cell] = await sql!<{ id: string }[]>`
      insert into vaults (id, kind, owner, slug, name, chunks_partition) values (${`vlt_c${run}`}, 'cell', ${`user:${member.id}`}, ${`az-c-${run}`}, 'Cella', ${`chunks_tc${run}`}) returning id`;
    const api = await auth!.principals.createApiAccount({ name: `bot-${run}`, scopes: ["read"] });
    await auth!.access.grant(member.id, v1!.id, "write", admin.id);
    await auth!.access.grant(api.id, v1!.id, "admin", admin.id);

    const ca = await auth!.access.context(admin);
    expect(Access.can(ca, "vault.admin", v2!.id)).toBe(true);
    expect(Access.can(ca, "admin.users")).toBe(true);

    const cm = await auth!.access.context(member);
    expect(Access.can(cm, "vault.write", v1!.id)).toBe(true);
    expect(Access.can(cm, "vault.curate", v1!.id)).toBe(false);
    expect(Access.can(cm, "vault.read", v2!.id)).toBe(false);
    expect(Access.can(cm, "vault.admin", cell!.id)).toBe(true);
    expect(Access.can(cm, "admin.users")).toBe(false);
    expect(Access.toReader(cm).vaults.sort()).toEqual([v1!.id, cell!.id].sort());

    const capi = await auth!.access.context(api);
    expect(Access.can(capi, "vault.read", v1!.id)).toBe(true);
    expect(Access.can(capi, "vault.write", v1!.id)).toBe(false); // read scope caps the admin grant
    expect(() => Access.require(capi, "admin.users")).toThrow(AuthError);

    // a key bound to the member: "projects" alone inherits none of the member's other vaults, "read" does
    const agent = await auth!.principals.createApiAccount({ name: `agent-p-${run}`, scopes: ["projects"], userId: member.id });
    expect(Access.toReader(await auth!.access.context(agent)).vaults).toEqual([]);
    const reader = await auth!.principals.createApiAccount({ name: `agent-r-${run}`, scopes: ["read", "projects"], userId: member.id });
    expect(Access.toReader(await auth!.access.context(reader)).vaults).toEqual([v1!.id]);
  });

  it("the projects scope writes project vaults and gives nothing elsewhere without read", () => {
    expect(apiCap(["projects"], true)).toBe("write");
    expect(apiCap(["projects"], false)).toBeNull();
    expect(apiCap(["projects", "admin"], false)).toBeNull();
    expect(apiCap(["read", "projects"], true)).toBe("write");
    expect(apiCap(["read", "projects"], false)).toBe("read");
    expect(apiCap(["read"], true)).toBe("read");
    expect(apiCap(["read"], false)).toBe("read");
    expect(apiCap(["ingest", "projects"], false)).toBe("write");
    expect(apiCap(["write"], false)).toBe("write");
    expect(apiCap(["admin"], false)).toBeNull();
  });
});

describe("bootstrap", () => {
  db()("creates the first administrator only once", async () => {
    // other tests created admins: bootstrap must refuse
    await expect(auth!.bootstrapAdmin(uname(), "Secondo")).rejects.toThrow(/già un amministratore/);
  });
});
