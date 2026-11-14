/**
 * Challenge login (plan §8.1): the client proves it holds the private key of the user.
 *
 *   1. GET  /auth/challenge?username=…   -> { challengeId, nonce, expiresAt }
 *   2. the client signs   "cb-auth-v1|<username>|<nonce>|<ts>"   (ts = Unix seconds)
 *   3. POST /auth/challenge               { username, challengeId, ts, signature }
 *
 * Keys: Ed25519, ECDSA P-256, or an X.509 certificate (Ed25519/P-256 key) issued by the
 * company CA. The nonce is single-use and lives 60 s; ts must be within ±60 s. An unknown
 * user still gets a challenge, so the endpoint does not reveal which users exist.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, X509Certificate, type KeyObject } from "node:crypto";
import type { Sql } from "@cb/db";
import { newId } from "@cb/shared";
import { randomToken, sha256hex } from "./crypto.ts";
import { AuthError } from "./errors.ts";

export const SIGNATURE_PREFIX = "cb-auth-v1";
const CHALLENGE_TTL_MS = 60_000;
const MAX_SKEW_S = 60;

export const signatureMessage = (username: string, nonce: string, ts: number) =>
  Buffer.from(`${SIGNATURE_PREFIX}|${username.trim().toLowerCase()}|${nonce}|${ts}`);

/** Client side (CLI, tests): signs the login message with a PEM private key. */
export function signLogin(privateKeyPem: string, username: string, nonce: string, ts = Math.floor(Date.now() / 1000)): { ts: number; signature: string } {
  const key = createPrivateKey(privateKeyPem);
  const msg = signatureMessage(username, nonce, ts);
  const sig = key.asymmetricKeyType === "ed25519" ? cryptoSign(null, msg, key) : cryptoSign("sha256", msg, { key, dsaEncoding: "ieee-p1363" });
  return { ts, signature: sig.toString("base64") };
}

export interface PublicKeyInfo {
  id: string;
  principalId: string;
  kind: "ed25519" | "ecdsa-p256" | "x509";
  fingerprint: string;
  name: string;
  notAfter: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function keyKind(k: KeyObject): "ed25519" | "ecdsa-p256" {
  if (k.asymmetricKeyType === "ed25519") return "ed25519";
  if (k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ecdsa-p256";
  throw new AuthError("invalid_request", "Tipo di chiave non supportato: usa Ed25519 o ECDSA P-256.");
}

function verifyWith(k: KeyObject, msg: Buffer, sig: Buffer): boolean {
  try {
    if (k.asymmetricKeyType === "ed25519") return cryptoVerify(null, msg, k, sig);
    return cryptoVerify("sha256", msg, { key: k, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig);
  } catch {
    return false;
  }
}

export class SignatureLogin {
  private readonly ca: X509Certificate[];

  /** `caPems`: certificates of the company CA(s) that may issue client certificates. */
  constructor(
    private readonly sql: Sql,
    caPems: string[] = [],
  ) {
    this.ca = caPems.map((p) => new X509Certificate(p));
  }

  async addKey(principalId: string, pem: string, name = "Chiave"): Promise<PublicKeyInfo> {
    let kind: PublicKeyInfo["kind"];
    let spki: Buffer;
    let notAfter: Date | null = null;
    try {
      if (pem.includes("BEGIN CERTIFICATE")) {
        const cert = new X509Certificate(pem);
        keyKind(cert.publicKey);
        this.checkCertificate(cert);
        kind = "x509";
        spki = cert.publicKey.export({ type: "spki", format: "der" });
        notAfter = new Date(cert.validTo);
      } else {
        const k = createPublicKey(pem);
        kind = keyKind(k);
        spki = k.export({ type: "spki", format: "der" });
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError("invalid_request", "Chiave o certificato non leggibile (formato PEM).");
    }
    try {
      const [row] = await this.sql<PublicKeyInfo[]>`
        insert into public_keys (id, principal_id, kind, pem, fingerprint, not_after, name)
        values (${newId("key")}, ${principalId}, ${kind}, ${pem.trim()}, ${sha256hex(spki)}, ${notAfter}, ${name})
        returning id, principal_id as "principalId", kind, fingerprint, name, not_after as "notAfter", revoked_at as "revokedAt",
                  created_at as "createdAt", last_used_at as "lastUsedAt"`;
      return row!;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AuthError("conflict", "Questa chiave è già registrata.");
      throw e;
    }
  }

  private checkCertificate(cert: X509Certificate, now = new Date()): void {
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) <= now) throw new AuthError("invalid_request", "Il certificato non è valido in questa data.");
    if (this.ca.length && !this.ca.some((ca) => cert.checkIssued(ca) && cert.verify(ca.publicKey))) {
      throw new AuthError("invalid_request", "Il certificato non è emesso dalla CA aziendale.");
    }
  }

  async listKeys(principalId: string): Promise<PublicKeyInfo[]> {
    return this.sql<PublicKeyInfo[]>`
      select id, principal_id as "principalId", kind, fingerprint, name, not_after as "notAfter", revoked_at as "revokedAt",
             created_at as "createdAt", last_used_at as "lastUsedAt"
      from public_keys where principal_id = ${principalId} order by created_at desc`;
  }

  async revokeKey(principalId: string, id: string): Promise<boolean> {
    const r = await this.sql`update public_keys set revoked_at = now() where id = ${id} and principal_id = ${principalId} and revoked_at is null`;
    return r.count > 0;
  }

  async challenge(username: string): Promise<{ challengeId: string; nonce: string; expiresAt: Date; format: string }> {
    const [p] = await this.sql<{ id: string }[]>`select id from principals where name = ${username.trim().toLowerCase()}`;
    const challengeId = newId("chl");
    const nonce = randomToken(32);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await this.sql`
      insert into auth_challenges (id, purpose, principal_id, challenge, expires_at)
      values (${challengeId}, 'signature-login', ${p?.id ?? null}, ${nonce}, ${expiresAt})`;
    return { challengeId, nonce, expiresAt, format: `${SIGNATURE_PREFIX}|<username>|<nonce>|<unix seconds>` };
  }

  /** Returns the principal id, or null (never says why: the caller records a failure). */
  async verify(input: { username: string; challengeId: string; ts: number; signature: string }): Promise<{ principalId: string; keyId: string } | null> {
    const [ch] = await this.sql<{ principal_id: string | null; challenge: string }[]>`
      update auth_challenges set used_at = now()
      where id = ${input.challengeId} and purpose = 'signature-login' and used_at is null and expires_at > now()
      returning principal_id, challenge`;
    if (!ch?.principal_id) return null;
    if (!Number.isInteger(input.ts) || Math.abs(Date.now() / 1000 - input.ts) > MAX_SKEW_S) return null;
    const [owner] = await this.sql<{ name: string }[]>`select name from principals where id = ${ch.principal_id}`;
    if (!owner || owner.name !== input.username.trim().toLowerCase()) return null;
    let sig: Buffer;
    try {
      sig = Buffer.from(input.signature, "base64");
    } catch {
      return null;
    }
    const msg = signatureMessage(owner.name, ch.challenge, input.ts);
    const keys = await this.sql<{ id: string; kind: string; pem: string }[]>`
      select id, kind, pem from public_keys where principal_id = ${ch.principal_id} and revoked_at is null`;
    for (const k of keys) {
      let pub: KeyObject;
      try {
        if (k.kind === "x509") {
          const cert = new X509Certificate(k.pem);
          this.checkCertificate(cert);
          pub = cert.publicKey;
        } else {
          pub = createPublicKey(k.pem);
        }
      } catch {
        continue; // expired or no longer trusted certificate
      }
      if (verifyWith(pub, msg, sig)) {
        await this.sql`update public_keys set last_used_at = now() where id = ${k.id}`;
        return { principalId: ch.principal_id, keyId: k.id };
      }
    }
    return null;
  }
}
