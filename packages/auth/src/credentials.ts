/**
 * TOTP enrollment and verification, recovery codes, API keys.
 *
 * Enrollment: the admin creates a user and gets a one-time code (24 h). The user opens the
 * enrollment page with it, scans the QR code, confirms with a first TOTP code and receives
 * 10 recovery codes (shown once). The admin can reset TOTP: same flow with a new code.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "@cb/db";
import { base32Encode, randomToken, SecretBox, safeEqual, sha256hex } from "./crypto.ts";
import { AuthError } from "./errors.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.ts";
import { isUsable, principalCols, type PrincipalRow } from "./principals.ts";

/** Human-friendly one-time code: 4 groups of 4 base32 characters (80 bits). */
function friendlyCode(): string {
  return base32Encode(randomBytes(10)).match(/.{4}/g)!.join("-");
}
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export class TotpCredentials {
  constructor(
    private readonly sql: Sql,
    private readonly box: SecretBox,
    private readonly issuer = "HiveVault",
  ) {}

  async createEnrollment(principalId: string, createdBy: string | null, ttlMs = 24 * 3600_000): Promise<{ code: string; expiresAt: Date }> {
    const code = friendlyCode();
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.sql`
      insert into enrollments (code_hash, principal_id, expires_at, created_by)
      values (${sha256hex(normalizeCode(code))}, ${principalId}, ${expiresAt}, ${createdBy})`;
    return { code, expiresAt };
  }

  private async enrollment(code: string): Promise<{ principalId: string; name: string }> {
    const [e] = await this.sql<{ principalId: string; name: string }[]>`
      select e.principal_id as "principalId", p.name from enrollments e join principals p on p.id = e.principal_id
      where e.code_hash = ${sha256hex(normalizeCode(code))} and e.used_at is null and e.expires_at > now() and p.status = 'active'`;
    if (!e) throw new AuthError("expired", "Codice di attivazione non valido o scaduto. Chiedine uno nuovo all'amministratore.");
    return e;
  }

  /** Step 1: a new (unconfirmed) secret; the code stays valid until the confirmation. */
  async startEnrollment(code: string): Promise<{ principalId: string; username: string; otpauthUri: string; secretBase32: string }> {
    const e = await this.enrollment(code);
    const secret = generateTotpSecret();
    await this.sql`
      insert into totp_secrets (principal_id, secret_enc, confirmed) values (${e.principalId}, ${this.box.seal(secret, e.principalId)}, false)
      on conflict (principal_id) do update set secret_enc = excluded.secret_enc, confirmed = false, last_step = 0, created_at = now()`;
    return { principalId: e.principalId, username: e.name, otpauthUri: otpauthUri(secret, e.name, this.issuer), secretBase32: base32Encode(secret) };
  }

  /** Step 2: the first code proves the app is set up. Returns the recovery codes (once). */
  async confirmEnrollment(code: string, totpCode: string): Promise<{ principalId: string; recoveryCodes: string[] }> {
    const e = await this.enrollment(code);
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ secret_enc: Buffer }[]>`select secret_enc from totp_secrets where principal_id = ${e.principalId} and not confirmed for update`;
      if (!row) throw new AuthError("invalid_request", "Prima avvia l'attivazione e inquadra il codice QR.");
      const step = verifyTotp(this.box.open(row.secret_enc, e.principalId), totpCode);
      if (step === null) throw new AuthError("invalid_credentials", "Codice non corretto. Controlla l'ora del telefono e riprova.");
      await tx`update totp_secrets set confirmed = true, last_step = ${step} where principal_id = ${e.principalId}`;
      await tx`update enrollments set used_at = now() where code_hash = ${sha256hex(normalizeCode(code))}`;
      await tx`delete from recovery_codes where principal_id = ${e.principalId}`;
      const codes = Array.from({ length: 10 }, () => base32Encode(randomBytes(5)).toLowerCase().replace(/(.{4})/, "$1-"));
      for (const c of codes) await tx`insert into recovery_codes (principal_id, code_hash) values (${e.principalId}, ${sha256hex(`${e.principalId}:${normalizeCode(c)}`)})`;
      return { principalId: e.principalId, recoveryCodes: codes };
    }) as Promise<{ principalId: string; recoveryCodes: string[] }>;
  }

  async hasTotp(principalId: string): Promise<boolean> {
    const [r] = await this.sql`select 1 from totp_secrets where principal_id = ${principalId} and confirmed`;
    return !!r;
  }

  /** Checks a code and records its step atomically (a code works once, also under races). */
  async verify(principalId: string, code: string): Promise<boolean> {
    const [row] = await this.sql<{ secret_enc: Buffer; last_step: number }[]>`
      select secret_enc, last_step from totp_secrets where principal_id = ${principalId} and confirmed`;
    if (!row) return false;
    const step = verifyTotp(this.box.open(row.secret_enc, principalId), code, { lastStep: Number(row.last_step) });
    if (step === null) return false;
    const r = await this.sql`update totp_secrets set last_step = ${step} where principal_id = ${principalId} and last_step < ${step}`;
    return r.count === 1;
  }

  async verifyRecovery(principalId: string, code: string): Promise<boolean> {
    const r = await this.sql`
      update recovery_codes set used_at = now()
      where principal_id = ${principalId} and code_hash = ${sha256hex(`${principalId}:${normalizeCode(code)}`)} and used_at is null`;
    return r.count === 1;
  }

  async remainingRecoveryCodes(principalId: string): Promise<number> {
    const [{ n }] = (await this.sql`select count(*)::int as n from recovery_codes where principal_id = ${principalId} and used_at is null`) as unknown as [{ n: number }];
    return n;
  }

  /** Admin reset: removes the secret and the recovery codes, returns a new enrollment code. */
  async reset(principalId: string, by: string | null): Promise<{ code: string; expiresAt: Date }> {
    await this.sql`delete from totp_secrets where principal_id = ${principalId}`;
    await this.sql`delete from recovery_codes where principal_id = ${principalId}`;
    await this.sql`update enrollments set used_at = now() where principal_id = ${principalId} and used_at is null`;
    return this.createEnrollment(principalId, by);
  }
}

// ---------------------------------------------------------------------------
// API keys: "cb_<id>_<secret>"
// ---------------------------------------------------------------------------
export interface ApiKeyInfo {
  id: string;
  principalId: string;
  name: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export class ApiKeys {
  constructor(private readonly sql: Sql) {}

  /** The full key is returned only here: the server keeps a hash. */
  async issue(principalId: string, name = "Chiave", expiresAt: Date | null = null): Promise<{ id: string; key: string }> {
    const id = base32Encode(randomBytes(8)).toLowerCase().slice(0, 12);
    const secret = randomToken(32);
    await this.sql`
      insert into api_keys (id, principal_id, secret_hash, name, expires_at)
      values (${id}, ${principalId}, ${sha256hex(secret)}, ${name}, ${expiresAt})`;
    return { id, key: `cb_${id}_${secret}` };
  }

  async verify(key: string): Promise<{ principal: PrincipalRow; keyId: string } | null> {
    const m = /^cb_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/.exec(key.trim());
    if (!m) return null;
    const [row] = await this.sql<(PrincipalRow & { secret_hash: string; key_expires: Date | null; key_revoked: Date | null })[]>`
      select ${this.sql.unsafe(principalCols("p"))}, k.secret_hash, k.expires_at as key_expires, k.revoked_at as key_revoked
      from api_keys k join principals p on p.id = k.principal_id where k.id = ${m[1]!}`;
    if (!row || !safeEqual(row.secret_hash, sha256hex(m[2]!))) return null;
    if (row.key_revoked || (row.key_expires && row.key_expires <= new Date())) return null;
    const { secret_hash: _h, key_expires: _e, key_revoked: _r, ...principal } = row;
    if (!isUsable(principal)) return null;
    await this.sql`update api_keys set last_used_at = now() where id = ${m[1]!} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
    return { principal, keyId: m[1]! };
  }

  async list(principalId: string): Promise<ApiKeyInfo[]> {
    return this.sql<ApiKeyInfo[]>`
      select id, principal_id as "principalId", name, expires_at as "expiresAt", revoked_at as "revokedAt",
             created_at as "createdAt", last_used_at as "lastUsedAt"
      from api_keys where principal_id = ${principalId} order by created_at desc`;
  }

  async revoke(principalId: string, id: string): Promise<boolean> {
    const r = await this.sql`update api_keys set revoked_at = now() where id = ${id} and principal_id = ${principalId} and revoked_at is null`;
    return r.count > 0;
  }
}
