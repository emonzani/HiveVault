/**
 * Login, enrollment, logout and the self-service of the logged-in user (/api/me).
 */
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Access, AuthError, type AuthService, type LoginResult } from "@cb/auth";
import { withReader } from "@cb/brain";
import { clearSessionCookies, meta, requireAuth, requireUser, setSessionCookies, SESSION_COOKIE } from "../http.ts";
import { principalView } from "../views.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;

export function authRoutes(app: FastifyInstance, auth: AuthService, secure: boolean): void {
  const loggedIn = (reply: Parameters<typeof setSessionCookies>[0], r: LoginResult, extra: Record<string, unknown> = {}) => {
    setSessionCookies(reply, r.session, secure);
    return { principal: principalView(r.principal), csrf: r.session.csrf, expiresAt: r.session.expiresAt, ...extra };
  };

  app.post<{ Body: { username: string; code: string } }>(
    "/api/auth/login/totp",
    { schema: { body: { type: "object", required: ["username", "code"], properties: { username: str(64), code: str(16) }, additionalProperties: false } } },
    async (req, reply) => loggedIn(reply, await auth.loginTotp(req.body.username, req.body.code, meta(req))),
  );

  app.post<{ Body: { username: string; code: string } }>(
    "/api/auth/login/recovery",
    { schema: { body: { type: "object", required: ["username", "code"], properties: { username: str(64), code: str(32) }, additionalProperties: false } } },
    async (req, reply) => {
      const r = await auth.loginRecovery(req.body.username, req.body.code, meta(req));
      return loggedIn(reply, r, { recoveryCodesLeft: await auth.totp.remainingRecoveryCodes(r.principal.id) });
    },
  );

  app.post<{ Body: { username?: string } }>(
    "/api/auth/passkey/options",
    { schema: { body: { type: "object", properties: { username: str(64) }, additionalProperties: false } } },
    async (req) => auth.passkeys.authenticationOptions(req.body?.username),
  );

  app.post<{ Body: { challengeId: string; response: AuthenticationResponseJSON } }>(
    "/api/auth/passkey/login",
    { schema: { body: { type: "object", required: ["challengeId", "response"], properties: { challengeId: str(64), response: { type: "object" } } } } },
    async (req, reply) => loggedIn(reply, await auth.loginPasskey(req.body.challengeId, req.body.response, meta(req))),
  );

  // Challenge (signature) login: used by the CLI and by edge devices, so the token is also in the body.
  app.get<{ Querystring: { username: string } }>(
    "/api/auth/challenge",
    { schema: { querystring: { type: "object", required: ["username"], properties: { username: str(64) } } } },
    async (req) => auth.signature.challenge(req.query.username),
  );

  // `origin`: the origin the client signed; optional, it only explains a refusal (origin_mismatch)
  app.post<{ Body: { username: string; challengeId: string; ts: number; signature: string; origin?: string } }>(
    "/api/auth/challenge",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "challengeId", "ts", "signature"],
          properties: { username: str(64), challengeId: str(64), ts: { type: "integer" }, signature: str(512), origin: str(255) },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const r = await auth.loginSignature(req.body, meta(req));
      return loggedIn(reply, r, { token: r.session.token, cookie: SESSION_COOKIE });
    },
  );

  app.post<{ Body: { code: string } }>(
    "/api/auth/enroll/start",
    { schema: { body: { type: "object", required: ["code"], properties: { code: str(64) }, additionalProperties: false } } },
    async (req) => {
      const s = await auth.totp.startEnrollment(req.body.code);
      return {
        username: s.username,
        otpauthUri: s.otpauthUri,
        secret: s.secretBase32,
        qrSvg: await QRCode.toString(s.otpauthUri, { type: "svg", errorCorrectionLevel: "M", margin: 1 }),
      };
    },
  );

  app.post<{ Body: { code: string; totp: string } }>(
    "/api/auth/enroll/confirm",
    { schema: { body: { type: "object", required: ["code", "totp"], properties: { code: str(64), totp: str(16) }, additionalProperties: false } } },
    async (req, reply) => {
      const r = await auth.enrollConfirm(req.body.code, req.body.totp, meta(req));
      return loggedIn(reply, r, { recoveryCodes: r.recoveryCodes });
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (token) await auth.logout(token, meta(req));
    clearSessionCookies(reply, secure);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Current principal and self-service
  // ---------------------------------------------------------------------------
  app.get("/api/auth/me", async (req) => {
    const a = requireAuth(req);
    const vaults = await auth.sql<{ id: string; slug: string; name: string; kind: string; owner: string | null }[]>`
      select id, slug, name, kind, owner from vaults where id = any(${[...a.ctx.vaults.keys()]}) order by kind, name`;
    // pages the caller can read (RLS: clearance), for the counters of the vault list
    const reader = Access.toReader(a.ctx);
    const counts = reader.vaults.length
      ? await withReader(auth.sql, reader, (tx) => tx<{ vaultId: string; n: number }[]>`
          select vault_id as "vaultId", count(*)::int as n from pages where vault_id = any(${reader.vaults}) group by 1`)
      : [];
    const pages = new Map(counts.map((c) => [c.vaultId, c.n]));
    return {
      principal: principalView(a.principal),
      via: a.via,
      isAdmin: a.ctx.isAdmin,
      clearance: a.ctx.clearance,
      csrf: a.session?.csrf ?? null,
      vaults: vaults.map((v) => ({ ...v, permission: a.ctx.vaults.get(v.id), pages: pages.get(v.id) ?? 0 })),
    };
  });

  app.get("/api/me/security", async (req) => {
    const a = requireUser(req);
    return {
      totp: await auth.totp.hasTotp(a.principal.id),
      recoveryCodesLeft: await auth.totp.remainingRecoveryCodes(a.principal.id),
      passkeys: await auth.passkeys.list(a.principal.id),
      publicKeys: await auth.signature.listKeys(a.principal.id),
      sessions: (await auth.sessions.list(a.principal.id)).map((s) => ({ ...s, current: s.id === a.session?.id })),
    };
  });

  app.post("/api/me/passkeys/options", async (req) => auth.passkeys.registrationOptions(requireUser(req).principal));

  app.post<{ Body: { challengeId: string; response: RegistrationResponseJSON; name?: string } }>(
    "/api/me/passkeys",
    { schema: { body: { type: "object", required: ["challengeId", "response"], properties: { challengeId: str(64), response: { type: "object" }, name: str(80) } } } },
    async (req) => {
      const a = requireUser(req);
      const pk = await auth.passkeys.verifyRegistration(a.principal.id, req.body.challengeId, req.body.response, req.body.name);
      await auth.audit.writeNow({ principalId: a.principal.id, action: "me.passkey.add", resource: pk.id, ...meta(req) });
      return pk;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/me/passkeys/:id", async (req) => {
    const a = requireUser(req);
    if (!(await auth.passkeys.remove(a.principal.id, req.params.id))) throw new AuthError("not_found", "Passkey non trovata.");
    await auth.audit.writeNow({ principalId: a.principal.id, action: "me.passkey.remove", resource: req.params.id, ...meta(req) });
    return { ok: true };
  });

  app.post<{ Body: { pem: string; name?: string } }>(
    "/api/me/public-keys",
    { schema: { body: { type: "object", required: ["pem"], properties: { pem: str(8000), name: str(80) }, additionalProperties: false } } },
    async (req) => {
      const a = requireUser(req);
      const k = await auth.signature.addKey(a.principal.id, req.body.pem, req.body.name);
      await auth.audit.writeNow({ principalId: a.principal.id, action: "me.key.add", resource: k.id, ...meta(req), data: { kind: k.kind, fingerprint: k.fingerprint } });
      return k;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/me/public-keys/:id", async (req) => {
    const a = requireUser(req);
    if (!(await auth.signature.revokeKey(a.principal.id, req.params.id))) throw new AuthError("not_found", "Chiave non trovata.");
    await auth.audit.writeNow({ principalId: a.principal.id, action: "me.key.revoke", resource: req.params.id, ...meta(req) });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/me/sessions/:id", async (req) => {
    const a = requireUser(req);
    const mine = (await auth.sessions.list(a.principal.id)).some((s) => s.id === req.params.id);
    if (!mine || !(await auth.sessions.revoke(req.params.id))) throw new AuthError("not_found", "Sessione non trovata.");
    return { ok: true };
  });
}
