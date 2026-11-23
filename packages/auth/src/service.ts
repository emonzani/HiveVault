/**
 * Login flows and request authentication, on top of the stores. Every login, successful or
 * not, goes through the same guard: lockout check -> verification -> session -> audit.
 */
import { BlockList, isIP } from "node:net";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Sql } from "@cb/db";
import { AuditLog } from "./audit.ts";
import { Access, type AccessContext } from "./authz.ts";
import { ApiKeys, TotpCredentials } from "./credentials.ts";
import { KeyedHash, SecretBox } from "./crypto.ts";
import { AuthError, LOGIN_FAILED } from "./errors.ts";
import { Lockout, type LockoutOptions } from "./lockout.ts";
import { Passkeys, type WebAuthnConfig } from "./passkeys.ts";
import { isUsable, Principals, type PrincipalRow } from "./principals.ts";
import { Sessions, type LoginMethod, type SessionInfo, type SessionOptions } from "./sessions.ts";
import { SignatureLogin } from "./signature.ts";

export interface AuthConfig {
  masterKey: Buffer;
  webauthn: WebAuthnConfig;
  session?: SessionOptions;
  lockout?: LockoutOptions;
  /** PEM certificates of the CA(s) that issue client certificates for the challenge login. */
  clientCaPems?: string[];
  issuer?: string;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  principal: PrincipalRow;
  session: { token: string; csrf: string; expiresAt: Date };
}

export interface Authenticated {
  principal: PrincipalRow;
  ctx: AccessContext;
  via: "session" | "apikey";
  session?: SessionInfo;
  keyId?: string;
}

export function ipAllowed(ip: string | null | undefined, cidrs: string[] | null): boolean {
  if (!cidrs || cidrs.length === 0) return true;
  if (!ip) return false;
  const addr = ip.replace(/^::ffff:/, "");
  const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
  const list = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split("/");
    const fam = isIP(net!) === 6 ? "ipv6" : "ipv4";
    list.addSubnet(net!, Number(bits ?? (fam === "ipv6" ? 128 : 32)), fam);
  }
  return list.check(addr, family);
}

export class AuthService {
  readonly principals: Principals;
  readonly totp: TotpCredentials;
  readonly apiKeys: ApiKeys;
  readonly sessions: Sessions;
  readonly signature: SignatureLogin;
  readonly passkeys: Passkeys;
  readonly lockout: Lockout;
  readonly access: Access;
  readonly audit: AuditLog;

  constructor(
    readonly sql: Sql,
    cfg: AuthConfig,
  ) {
    this.principals = new Principals(sql);
    this.totp = new TotpCredentials(sql, new SecretBox(cfg.masterKey, "totp"), new KeyedHash(cfg.masterKey, "recovery"), cfg.issuer);
    this.apiKeys = new ApiKeys(sql);
    this.sessions = new Sessions(sql, cfg.session);
    this.signature = new SignatureLogin(sql, cfg.webauthn.origins, cfg.clientCaPems ?? []);
    this.passkeys = new Passkeys(sql, cfg.webauthn);
    this.lockout = new Lockout(sql, cfg.lockout);
    this.access = new Access(sql);
    this.audit = new AuditLog(sql);
  }

  // ---------------------------------------------------------------------------
  // Logins
  // ---------------------------------------------------------------------------
  private async guard(username: string, method: LoginMethod, meta: RequestMeta, verify: (p: PrincipalRow) => Promise<boolean>): Promise<LoginResult> {
    const name = username.trim().toLowerCase();
    // Check and reservation are one atomic step per username: concurrent attempts each see
    // the ones before them, so no more than the threshold reach verification.
    const lock = await this.lockout.reserve(name, meta.ip);
    if (lock.locked) {
      await this.audit.writeNow({ action: `login.${method}`, resource: name, outcome: "denied", ip: meta.ip, userAgent: meta.userAgent, data: { reason: "locked" } });
      throw new AuthError("locked", `Troppi tentativi non riusciti. Riprova tra ${Math.ceil(lock.retryAfterMs / 60_000)} minuti.`, lock.retryAfterMs);
    }
    let p: PrincipalRow | undefined;
    let ok: boolean;
    try {
      p = await this.principals.getByName(name);
      ok = !!p && p.kind === "user" && isUsable(p) && (await verify(p));
    } catch (e) {
      // an error (not a wrong credential) is not recorded as a failure, as before the reservation
      await this.lockout.release(lock.id).catch(() => {});
      throw e;
    }
    if (!ok) {
      await this.lockout.fail(name, meta.ip, lock.id);
      await this.audit.writeNow({ principalId: p?.id ?? null, action: `login.${method}`, resource: name, outcome: "denied", ip: meta.ip, userAgent: meta.userAgent });
      throw new AuthError("invalid_credentials", LOGIN_FAILED);
    }
    return this.open(p!, method, meta);
  }

  private async open(p: PrincipalRow, method: LoginMethod, meta: RequestMeta): Promise<LoginResult> {
    await this.lockout.clear(p.name);
    const session = await this.sessions.create(p.id, method, meta);
    await this.audit.writeNow({ principalId: p.id, action: `login.${method}`, resource: p.name, ip: meta.ip, userAgent: meta.userAgent });
    return { principal: p, session };
  }

  loginTotp(username: string, code: string, meta: RequestMeta = {}): Promise<LoginResult> {
    return this.guard(username, "totp", meta, (p) => this.totp.verify(p.id, code));
  }

  loginRecovery(username: string, code: string, meta: RequestMeta = {}): Promise<LoginResult> {
    return this.guard(username, "recovery", meta, (p) => this.totp.verifyRecovery(p.id, code));
  }

  /**
   * A refused signature (old v1 message, or an origin this server does not accept) is valid for a
   * key of the user, so it comes from the key holder: its own error and audit event, no session,
   * and the throw leaves `guard` before it counts a failure toward the lockout.
   */
  loginSignature(input: { username: string; challengeId: string; ts: number; signature: string; origin?: string }, meta: RequestMeta = {}): Promise<LoginResult> {
    return this.guard(input.username, "signature", meta, async (p) => {
      const r = await this.signature.verify(input);
      if (!r) return false;
      if (!("refused" in r)) return r.principalId === p.id;
      if (r.ownerId !== p.id) return false;
      const outdated = r.refused === "outdated";
      await this.audit.writeNow({
        principalId: p.id,
        action: outdated ? "login.signature.outdated" : "login.signature.origin",
        resource: p.name,
        outcome: "denied",
        ip: meta.ip,
        userAgent: meta.userAgent,
        data: { keyId: r.keyId, ...(r.origin ? { origin: r.origin } : {}) },
      });
      throw outdated
        ? new AuthError("signature_outdated", "Firma nel formato vecchio (cb-auth-v1): aggiorna il client. Il server accetta solo cb-auth-v2, che contiene l'indirizzo del server.")
        : new AuthError("origin_mismatch", "La firma è per un indirizzo che questo server non accetta: usa l'indirizzo pubblico del server (PUBLIC_URL).");
    });
  }

  /** Passkeys are phishing-resistant and cannot be guessed: no username, no lockout. */
  async loginPasskey(challengeId: string, response: AuthenticationResponseJSON, meta: RequestMeta = {}): Promise<LoginResult> {
    const r = await this.passkeys.verifyAuthentication(challengeId, response);
    const p = r ? await this.principals.get(r.principalId) : undefined;
    if (!p || p.kind !== "user" || !isUsable(p)) {
      await this.audit.writeNow({ principalId: p?.id ?? null, action: "login.passkey", outcome: "denied", ip: meta.ip, userAgent: meta.userAgent });
      throw new AuthError("invalid_credentials", "Accesso con passkey non riuscito.");
    }
    return this.open(p, "passkey", meta);
  }

  /** Enrollment confirmed: the user is logged in at once (no second TOTP code needed). */
  async enrollConfirm(code: string, totpCode: string, meta: RequestMeta = {}): Promise<LoginResult & { recoveryCodes: string[] }> {
    const { principalId, recoveryCodes } = await this.totp.confirmEnrollment(code, totpCode);
    const p = (await this.principals.get(principalId))!;
    await this.audit.writeNow({ principalId, action: "enroll.totp", resource: p.name, ip: meta.ip, userAgent: meta.userAgent });
    return { ...(await this.open(p, "totp", meta)), recoveryCodes };
  }

  async logout(token: string, meta: RequestMeta = {}): Promise<void> {
    const s = await this.sessions.resolve(token);
    await this.sessions.revokeToken(token);
    if (s) this.audit.write({ principalId: s.principal.id, action: "logout", ip: meta.ip, userAgent: meta.userAgent });
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------
  async authenticate(input: { sessionToken?: string | undefined; bearer?: string | undefined; ip?: string | null }): Promise<Authenticated | null> {
    if (input.bearer) {
      const r = await this.apiKeys.verify(input.bearer);
      if (!r) return null;
      if (!ipAllowed(input.ip, r.principal.allowedIps)) {
        this.audit.write({ principalId: r.principal.id, action: "auth.apikey", outcome: "denied", ip: input.ip ?? null, data: { reason: "ip" } });
        return null;
      }
      await this.principals.touch(r.principal.id);
      return { principal: r.principal, ctx: await this.access.context(r.principal), via: "apikey", keyId: r.keyId };
    }
    if (input.sessionToken) {
      const r = await this.sessions.resolve(input.sessionToken);
      if (!r) return null;
      return { principal: r.principal, ctx: await this.access.context(r.principal), via: "session", session: r.session };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // First administrator (CLI)
  // ---------------------------------------------------------------------------
  async bootstrapAdmin(username: string, displayName: string): Promise<{ principal: PrincipalRow; enrollment: { code: string; expiresAt: Date } }> {
    if ((await this.principals.countAdmins()) > 0) {
      throw new AuthError("conflict", "Esiste già un amministratore: crea gli altri account dalla console.");
    }
    const principal = await this.principals.createUser({ username, displayName, role: "admin", clearance: 3 });
    const enrollment = await this.totp.createEnrollment(principal.id, null);
    await this.audit.writeNow({ principalId: principal.id, action: "admin.bootstrap", resource: principal.name });
    return { principal, enrollment };
  }

  async stop(): Promise<void> {
    await this.audit.stop();
  }
}
