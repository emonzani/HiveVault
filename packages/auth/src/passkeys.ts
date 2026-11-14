/**
 * WebAuthn passkeys (plan §8.1). Registration needs a logged-in user (or an enrollment
 * session); login works with discoverable credentials (no username) or for a given user.
 * Attestation "none": we trust the user's device, we do not certify its brand.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Sql } from "@cb/db";
import { newId } from "@cb/shared";
import { AuthError } from "./errors.ts";

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  /** Allowed origins, e.g. ["https://brain.azienda.local", "http://localhost:5310"]. */
  origins: string[];
}

export interface PasskeyInfo {
  id: string;
  principalId: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const TTL_MS = 5 * 60_000;

export class Passkeys {
  constructor(
    private readonly sql: Sql,
    private readonly cfg: WebAuthnConfig,
  ) {}

  private async saveChallenge(purpose: "passkey-register" | "passkey-login", principalId: string | null, challenge: string): Promise<string> {
    const id = newId("chl");
    await this.sql`
      insert into auth_challenges (id, purpose, principal_id, challenge, expires_at)
      values (${id}, ${purpose}, ${principalId}, ${challenge}, ${new Date(Date.now() + TTL_MS)})`;
    return id;
  }

  private async consumeChallenge(id: string, purpose: string): Promise<{ principalId: string | null; challenge: string } | null> {
    const [c] = await this.sql<{ principalId: string | null; challenge: string }[]>`
      update auth_challenges set used_at = now()
      where id = ${id} and purpose = ${purpose} and used_at is null and expires_at > now()
      returning principal_id as "principalId", challenge`;
    return c ?? null;
  }

  async registrationOptions(principal: { id: string; name: string; displayName: string }): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const existing = await this.sql<{ id: string; transports: string[] }[]>`select id, transports from passkeys where principal_id = ${principal.id}`;
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: principal.name,
      userID: new TextEncoder().encode(principal.id),
      userDisplayName: principal.displayName,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    return { challengeId: await this.saveChallenge("passkey-register", principal.id, options.challenge), options };
  }

  async verifyRegistration(principalId: string, challengeId: string, response: RegistrationResponseJSON, name = "Passkey"): Promise<PasskeyInfo> {
    const ch = await this.consumeChallenge(challengeId, "passkey-register");
    if (!ch || ch.principalId !== principalId) throw new AuthError("expired", "Richiesta scaduta: avvia di nuovo la registrazione della passkey.");
    let v;
    try {
      v = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.cfg.origins,
        expectedRPID: this.cfg.rpId,
        requireUserVerification: false,
      });
    } catch {
      throw new AuthError("invalid_request", "La passkey non è stata accettata dal server.");
    }
    if (!v.verified) throw new AuthError("invalid_request", "La passkey non è stata accettata dal server.");
    const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
    try {
      const [row] = await this.sql<PasskeyInfo[]>`
        insert into passkeys (id, principal_id, public_key, counter, transports, device_type, backed_up, name)
        values (${credential.id}, ${principalId}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
                ${credential.transports ?? []}, ${credentialDeviceType}, ${credentialBackedUp}, ${name})
        returning id, principal_id as "principalId", name, device_type as "deviceType", backed_up as "backedUp",
                  created_at as "createdAt", last_used_at as "lastUsedAt"`;
      return row!;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AuthError("conflict", "Questa passkey è già registrata.");
      throw e;
    }
  }

  /** Without a username: the browser offers the passkeys it has for this site. */
  async authenticationOptions(username?: string): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    let principalId: string | null = null;
    let allow: { id: string; transports: AuthenticatorTransportFuture[] }[] = [];
    if (username) {
      const [p] = await this.sql<{ id: string }[]>`select id from principals where name = ${username.trim().toLowerCase()}`;
      principalId = p?.id ?? null;
      if (p) {
        const rows = await this.sql<{ id: string; transports: string[] }[]>`select id, transports from passkeys where principal_id = ${p.id}`;
        allow = rows.map((r) => ({ id: r.id, transports: r.transports as AuthenticatorTransportFuture[] }));
      }
    }
    const options = await generateAuthenticationOptions({ rpID: this.cfg.rpId, allowCredentials: allow, userVerification: "preferred" });
    return { challengeId: await this.saveChallenge("passkey-login", principalId, options.challenge), options };
  }

  async verifyAuthentication(challengeId: string, response: AuthenticationResponseJSON): Promise<{ principalId: string; passkeyId: string } | null> {
    const ch = await this.consumeChallenge(challengeId, "passkey-login");
    if (!ch) return null;
    const [pk] = await this.sql<{ id: string; principal_id: string; public_key: Buffer; counter: number; transports: string[] }[]>`
      select id, principal_id, public_key, counter, transports from passkeys where id = ${response.id}`;
    if (!pk) return null;
    if (ch.principalId && ch.principalId !== pk.principal_id) return null;
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.cfg.origins,
        expectedRPID: this.cfg.rpId,
        credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as AuthenticatorTransportFuture[] },
        requireUserVerification: false,
      });
    } catch {
      return null;
    }
    if (!v.verified) return null;
    await this.sql`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${pk.id}`;
    return { principalId: pk.principal_id, passkeyId: pk.id };
  }

  async list(principalId: string): Promise<PasskeyInfo[]> {
    return this.sql<PasskeyInfo[]>`
      select id, principal_id as "principalId", name, device_type as "deviceType", backed_up as "backedUp",
             created_at as "createdAt", last_used_at as "lastUsedAt"
      from passkeys where principal_id = ${principalId} order by created_at desc`;
  }

  async remove(principalId: string, id: string): Promise<boolean> {
    const r = await this.sql`delete from passkeys where id = ${id} and principal_id = ${principalId}`;
    return r.count > 0;
  }
}
