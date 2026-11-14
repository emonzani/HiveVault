/**
 * Administration API (plan §8.3): principals, credentials, vaults, grants, sessions, audit.
 * Every change is audited with `writeNow` (security events are not buffered).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError, PERMISSIONS, SCOPES, verifyAuditChain, type AuthService, type Permission, type Scope, type UpdatePrincipal } from "@cb/auth";
import { isPersonalOwner, PERSONAL, type VaultStore, type VectorIndexKind } from "@cb/brain";
import type { IngestService } from "@cb/ingest";
import { meta, requireAction } from "../http.ts";
import { principalView } from "../views.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const nullable = <T extends object>(s: T) => ({ anyOf: [s, { type: "null" }] }) as const;

/** Lowest default classification of a personal vault: never readable by the cloud agent (privacy by default). */
/** A vault that stops being personal and had "personale" as default: riservato, never readable by the cloud agent. */
export const FORMER_PERSONAL_CLASSIFICATION = 2;

/**
 * `defaultClassification`: classification of new vaults when the request sets none (console setting).
 * `ingest`: deletes original files with the content of a deleted account or vault.
 */
export function adminRoutes(app: FastifyInstance, auth: AuthService, vaults: VaultStore, defaultClassification: () => number = () => 1, ingest?: IngestService): void {
  const audit = (req: FastifyRequest, action: string, resource: string | null, data?: Record<string, unknown>) =>
    auth.audit.writeNow({ principalId: req.auth?.principal.id ?? null, action, resource, ...meta(req), data: data ?? null });

  /** The last active administrator cannot be removed, suspended or demoted. */
  async function keepOneAdmin(id: string, change: { role?: string; status?: string; delete?: boolean }) {
    const p = await auth.principals.get(id);
    if (!p || p.role !== "admin" || p.status !== "active") return;
    const losing = change.delete || (change.role && change.role !== "admin") || change.status === "suspended";
    if (losing && (await auth.principals.countAdmins()) <= 1) {
      throw new AuthError("conflict", "Non puoi rimuovere l'ultimo amministratore attivo.");
    }
  }

  // ---------------------------------------------------------------------------
  // Principals
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { kind?: "user" | "api" | "team"; q?: string; limit?: number; offset?: number } }>(
    "/api/admin/principals",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { kind: { enum: ["user", "api", "team"] }, q: str(100), limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (req) => {
      requireAction(req, "admin.users");
      const r = await auth.principals.list(req.query);
      return { items: r.items.map(principalView), total: r.total };
    },
  );

  app.post<{ Body: { username: string; displayName: string; email?: string; role?: "admin" | "curator" | "member"; clearance?: number } }>(
    "/api/admin/users",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "displayName"],
          properties: {
            username: str(63),
            displayName: str(120),
            email: { type: "string", format: "email", maxLength: 200 },
            role: { enum: ["admin", "curator", "member"] },
            clearance: { type: "integer", minimum: 0, maximum: 3 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const a = requireAction(req, "admin.users");
      const p = await auth.principals.createUser({ ...req.body, createdBy: a.principal.id });
      const enrollment = await auth.totp.createEnrollment(p.id, a.principal.id);
      await audit(req, "admin.user.create", p.id, { username: p.name, role: p.role });
      return reply.status(201).send({ principal: principalView(p), enrollment });
    },
  );

  app.post<{ Body: { name: string; displayName?: string; scopes: Scope[]; clearance?: number; expiresAt?: string | null; allowedIps?: string[] | null; ratePerMin?: number | null; userId?: string | null } }>(
    "/api/admin/api-accounts",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "scopes"],
          properties: {
            name: str(63),
            displayName: str(120),
            scopes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: SCOPES } },
            clearance: { type: "integer", minimum: 0, maximum: 3 },
            expiresAt: nullable({ type: "string", format: "date-time" }),
            allowedIps: nullable({ type: "array", maxItems: 50, items: str(50) }),
            ratePerMin: nullable({ type: "integer", minimum: 1, maximum: 100000 }),
            userId: nullable(str(40)),
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const a = requireAction(req, "admin.api");
      const p = await auth.principals.createApiAccount({
        ...req.body,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
        createdBy: a.principal.id,
      });
      const key = await auth.apiKeys.issue(p.id, "Prima chiave", p.expiresAt);
      await audit(req, "admin.api.create", p.id, { name: p.name, scopes: p.scopes, clearance: p.clearance, userId: p.userId });
      return reply.status(201).send({ principal: principalView(p), key: key.key, keyId: key.id, notice: "Copia la chiave ora: non verrà mostrata di nuovo." });
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/principals/:id", async (req) => {
    requireAction(req, "admin.users");
    const p = await auth.principals.get(req.params.id);
    if (!p) throw new AuthError("not_found", "Account non trovato.");
    const grants = await auth.sql<{ vaultId: string; permission: Permission; slug: string; name: string }[]>`
      select g.vault_id as "vaultId", g.permission, v.slug, v.name from vault_grants g join vaults v on v.id = g.vault_id
      where g.principal_id = ${p.id} order by v.slug`;
    return {
      principal: principalView(p),
      teams: p.kind === "user" ? await auth.principals.teamsOf(p.id) : [],
      actsFor: p.userId ? await auth.principals.get(p.userId).then((u) => (u ? { id: u.id, name: u.name, displayName: u.displayName } : null)) : null,
      members: p.kind === "team" ? await auth.principals.members(p.id) : [],
      totp: await auth.totp.hasTotp(p.id),
      recoveryCodesLeft: await auth.totp.remainingRecoveryCodes(p.id),
      passkeys: await auth.passkeys.list(p.id),
      publicKeys: await auth.signature.listKeys(p.id),
      apiKeys: await auth.apiKeys.list(p.id),
      sessions: await auth.sessions.list(p.id),
      grants,
    };
  });

  app.patch<{ Params: { id: string }; Body: { displayName?: string; email?: string | null; role?: "admin" | "curator" | "member"; scopes?: Scope[]; clearance?: number; status?: "active" | "suspended"; expiresAt?: string | null; allowedIps?: string[] | null; ratePerMin?: number | null } }>(
    "/api/admin/principals/:id",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          properties: {
            displayName: str(120),
            email: nullable({ type: "string", format: "email", maxLength: 200 }),
            role: { enum: ["admin", "curator", "member"] },
            scopes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: SCOPES } },
            clearance: { type: "integer", minimum: 0, maximum: 3 },
            status: { enum: ["active", "suspended"] },
            expiresAt: nullable({ type: "string", format: "date-time" }),
            allowedIps: nullable({ type: "array", maxItems: 50, items: str(50) }),
            ratePerMin: nullable({ type: "integer", minimum: 1, maximum: 100000 }),
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const a = requireAction(req, "admin.users");
      if (req.params.id === a.principal.id && (req.body.status === "suspended" || (req.body.role && req.body.role !== "admin"))) {
        throw new AuthError("conflict", "Non puoi sospendere o retrocedere il tuo account.");
      }
      await keepOneAdmin(req.params.id, req.body);
      const patch: UpdatePrincipal = { ...req.body, expiresAt: req.body.expiresAt === undefined ? undefined : req.body.expiresAt ? new Date(req.body.expiresAt) : null };
      const p = await auth.principals.update(req.params.id, patch);
      if (req.body.status === "suspended") await auth.sessions.revokeAllFor(p.id);
      await audit(req, "admin.principal.update", p.id, { changes: req.body });
      return { principal: principalView(p) };
    },
  );

  /**
   * Deletes an account. A user's personal vaults: their "personale" content is deleted (pages,
   * sources, original files); what is left goes to a team (owner "team:<id>"), or the vault is
   * deleted when nothing is left. The team: `?team=<id>`, or the only team of the user.
   * A team that owns vaults is not deleted: its vaults go to another owner first.
   */
  app.delete<{ Params: { id: string }; Querystring: { team?: string } }>(
    "/api/admin/principals/:id",
    { schema: { querystring: { type: "object", properties: { team: str(64) }, additionalProperties: false } } },
    async (req) => {
      const a = requireAction(req, "admin.users");
      if (req.params.id === a.principal.id) throw new AuthError("conflict", "Non puoi eliminare il tuo account.");
      const p = await auth.principals.get(req.params.id);
      if (!p) throw new AuthError("not_found", "Account non trovato.");
      await keepOneAdmin(p.id, { delete: true });
      if (p.kind === "team") {
        const [owned] = await auth.sql`select 1 from vaults where owner = ${`team:${p.id}`} limit 1`;
        if (owned) throw new AuthError("conflict", "Il team possiede dei vault: assegnali prima a un altro proprietario.");
      }
      const outcome: { vault: string; slug: string; action: "transferred" | "deleted"; personal: { pages: number; sources: number; blobs: number } }[] = [];
      let heir: { id: string; displayName: string } | null = null;
      if (p.kind === "user") {
        const own = await auth.sql<{ id: string; slug: string; name: string; left: number }[]>`
          select v.id, v.slug, v.name,
                 (select count(*)::int from pages x where x.vault_id = v.id and x.classification <> ${PERSONAL})
                 + (select count(*)::int from sources s where s.vault_id = v.id and s.classification <> ${PERSONAL}) as left
          from vaults v where v.owner = ${`user:${p.id}`} order by v.slug`;
        if (own.length && !ingest) throw new AuthError("invalid_request", "Cancellazione dei vault personali non disponibile in questo processo.");
        if (own.some((v) => v.left > 0)) {
          const teams = await auth.principals.teamsOf(p.id);
          if (req.query.team) {
            const t = await auth.principals.get(req.query.team);
            if (!t || t.kind !== "team") throw new AuthError("invalid_request", "Team non trovato.");
            heir = { id: t.id, displayName: t.displayName };
          } else if (teams.length === 1) heir = teams[0]!;
          else {
            throw new AuthError(
              "conflict",
              teams.length
                ? "L'utente appartiene a più team: scegli il team che riceve i suoi contenuti non personali."
                : "L'utente non appartiene a nessun team: scegli il team che riceve i suoi contenuti non personali.",
            );
          }
        }
        for (const v of own) {
          const personal = await ingest!.purgePersonal(v.id);
          if (v.left > 0 && heir) {
            await auth.sql`
              update vaults set owner = ${`team:${heir.id}`}, default_classification = case when default_classification = ${PERSONAL} then ${FORMER_PERSONAL_CLASSIFICATION} else default_classification end, updated_at = now()
              where id = ${v.id}`;
            await auth.sql`
              insert into vault_log (vault_id, kind, title, ref, classification)
              values (${v.id}, 'owner', ${`Vault passato al team «${heir.displayName}» dopo la cancellazione dell'account proprietario`}, ${heir.id}, 0)`;
            outcome.push({ vault: v.id, slug: v.slug, action: "transferred", personal });
          } else {
            await ingest!.deleteVaultFiles(v.id);
            await vaults.delete(v.id);
            outcome.push({ vault: v.id, slug: v.slug, action: "deleted", personal });
          }
        }
      }
      if (!(await auth.principals.delete(p.id))) throw new AuthError("not_found", "Account non trovato.");
      await audit(req, "admin.principal.delete", p.id, { kind: p.kind, ...(heir ? { team: heir.id } : {}), vaults: outcome });
      return { ok: true, team: heir, vaults: outcome };
    },
  );

  // ---------------------------------------------------------------------------
  // Teams: groups of users. Grants to a team reach its members; vaults owned by a team
  // ("team:<id>") are writable by its members.
  // ---------------------------------------------------------------------------
  app.post<{ Body: { name: string; displayName?: string } }>(
    "/api/admin/teams",
    { schema: { body: { type: "object", required: ["name"], properties: { name: str(63), displayName: str(120) }, additionalProperties: false } } },
    async (req, reply) => {
      const a = requireAction(req, "admin.users");
      const t = await auth.principals.createTeam({ ...req.body, createdBy: a.principal.id });
      await audit(req, "admin.team.create", t.id, { name: t.name });
      return reply.status(201).send({ principal: principalView(t) });
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/teams/:id/members", async (req) => {
    requireAction(req, "admin.users");
    const t = await auth.principals.get(req.params.id);
    if (!t || t.kind !== "team") throw new AuthError("not_found", "Team non trovato.");
    return auth.principals.members(t.id);
  });

  app.put<{ Params: { id: string; userId: string } }>("/api/admin/teams/:id/members/:userId", async (req) => {
    const a = requireAction(req, "admin.users");
    await auth.principals.addMember(req.params.id, req.params.userId, a.principal.id);
    await audit(req, "admin.team.member.add", req.params.id, { member: req.params.userId });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/admin/teams/:id/members/:userId", async (req) => {
    requireAction(req, "admin.users");
    if (!(await auth.principals.removeMember(req.params.id, req.params.userId))) throw new AuthError("not_found", "Il membro non fa parte del team.");
    await audit(req, "admin.team.member.remove", req.params.id, { member: req.params.userId });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/principals/:id/reset-totp", async (req) => {
    const a = requireAction(req, "admin.users");
    const p = await auth.principals.get(req.params.id);
    if (!p || p.kind !== "user") throw new AuthError("not_found", "Utente non trovato.");
    const enrollment = await auth.totp.reset(p.id, a.principal.id);
    await auth.sessions.revokeAllFor(p.id);
    await audit(req, "admin.user.reset_totp", p.id);
    return { enrollment };
  });

  app.post<{ Params: { id: string } }>("/api/admin/principals/:id/revoke-sessions", async (req) => {
    requireAction(req, "admin.sessions");
    const n = await auth.sessions.revokeAllFor(req.params.id);
    await audit(req, "admin.sessions.revoke_all", req.params.id, { revoked: n });
    return { revoked: n };
  });

  app.post<{ Params: { id: string }; Body: { name?: string; expiresAt?: string | null } }>(
    "/api/admin/principals/:id/api-keys",
    { schema: { body: { type: "object", properties: { name: str(80), expiresAt: nullable({ type: "string", format: "date-time" }) }, additionalProperties: false } } },
    async (req, reply) => {
      requireAction(req, "admin.api");
      const p = await auth.principals.get(req.params.id);
      if (!p || p.kind !== "api") throw new AuthError("not_found", "Account API non trovato.");
      const key = await auth.apiKeys.issue(p.id, req.body?.name ?? "Chiave", req.body?.expiresAt ? new Date(req.body.expiresAt) : null);
      await audit(req, "admin.api.key.issue", p.id, { keyId: key.id });
      return reply.status(201).send({ key: key.key, keyId: key.id, notice: "Copia la chiave ora: non verrà mostrata di nuovo." });
    },
  );

  app.delete<{ Params: { id: string; keyId: string } }>("/api/admin/principals/:id/api-keys/:keyId", async (req) => {
    requireAction(req, "admin.api");
    if (!(await auth.apiKeys.revoke(req.params.id, req.params.keyId))) throw new AuthError("not_found", "Chiave non trovata.");
    await audit(req, "admin.api.key.revoke", req.params.id, { keyId: req.params.keyId });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { pem: string; name?: string } }>(
    "/api/admin/principals/:id/public-keys",
    { schema: { body: { type: "object", required: ["pem"], properties: { pem: str(8000), name: str(80) }, additionalProperties: false } } },
    async (req, reply) => {
      requireAction(req, "admin.users");
      if (!(await auth.principals.get(req.params.id))) throw new AuthError("not_found", "Account non trovato.");
      const k = await auth.signature.addKey(req.params.id, req.body.pem, req.body.name);
      await audit(req, "admin.key.add", req.params.id, { keyId: k.id, kind: k.kind, fingerprint: k.fingerprint });
      return reply.status(201).send(k);
    },
  );

  app.delete<{ Params: { id: string; keyId: string } }>("/api/admin/principals/:id/public-keys/:keyId", async (req) => {
    requireAction(req, "admin.users");
    if (!(await auth.signature.revokeKey(req.params.id, req.params.keyId))) throw new AuthError("not_found", "Chiave non trovata.");
    await audit(req, "admin.key.revoke", req.params.id, { keyId: req.params.keyId });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; passkeyId: string } }>("/api/admin/principals/:id/passkeys/:passkeyId", async (req) => {
    requireAction(req, "admin.users");
    if (!(await auth.passkeys.remove(req.params.id, req.params.passkeyId))) throw new AuthError("not_found", "Passkey non trovata.");
    await audit(req, "admin.passkey.remove", req.params.id, { passkeyId: req.params.passkeyId });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Vaults
  // ---------------------------------------------------------------------------
  // Access matches the owner "user:<principal id>"; the console also accepts the username.
  async function resolveOwner(owner: string): Promise<string>;
  async function resolveOwner(owner: string | null): Promise<string | null>;
  async function resolveOwner(owner: string | null): Promise<string | null> {
    const kind = owner?.startsWith("user:") ? "user" : owner?.startsWith("team:") ? "team" : null;
    if (!owner || !kind) return owner;
    const ref = owner.slice(5);
    const [p] = await auth.sql<{ id: string }[]>`select id from principals where kind = ${kind} and (id = ${ref} or name = ${ref})`;
    if (!p) throw new AuthError("invalid_request", kind === "user" ? `Proprietario non valido: l'utente "${ref}" non esiste.` : `Proprietario non valido: il team "${ref}" non esiste.`);
    return `${kind}:${p.id}`;
  }

  /** Default classification of a vault: "personale" only in a personal vault, where it is the default. */
  function vaultDefault(owner: string | null, wanted: number | undefined): number {
    if (wanted === PERSONAL && !isPersonalOwner(owner)) throw new AuthError("invalid_request", "La classificazione «personale» vale solo nei vault personali.");
    const d = wanted ?? defaultClassification();
    return isPersonalOwner(owner) && wanted === undefined ? PERSONAL : d;
  }

  app.get("/api/admin/vaults", async (req) => {
    requireAction(req, "admin.vaults");
    return auth.sql`
      select v.id, v.kind, v.owner, o.display_name as "ownerLabel", v.slug, v.name, v.default_classification as "defaultClassification", v.vector_index as "vectorIndex",
             v.version, v.created_at as "createdAt", v.updated_at as "updatedAt",
             (select count(*)::int from pages p where p.vault_id = v.id) as pages,
             (select count(*)::int from sources s where s.vault_id = v.id) as sources,
             (select count(*)::int from vault_grants g where g.vault_id = v.id) as grants
      from vaults v left join principals o on v.owner = o.kind || ':' || o.id
      order by v.kind, v.slug`;
  });

  // Owner suggestions of the vault form: users by name, the other kinds from the owners in use.
  app.get<{ Querystring: { kind: "user" | "edge" | "team" | "project"; q: string } }>(
    "/api/admin/owners",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["kind", "q"],
          properties: { kind: { enum: ["user", "edge", "team", "project"] }, q: str(100) },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      requireAction(req, "admin.vaults");
      const q = `%${req.query.q.toLowerCase()}%`;
      if (req.query.kind === "user" || req.query.kind === "team") {
        return auth.sql<{ value: string; label: string; hint: string }[]>`
          select id as value, display_name as label, name as hint from principals
          where kind = ${req.query.kind} and (name like ${q} or lower(display_name) like ${q} or lower(coalesce(email, '')) like ${q})
          order by display_name limit 20`;
      }
      const prefix = `${req.query.kind}:`;
      return auth.sql<{ value: string; label: string }[]>`
        select distinct substr(owner, ${prefix.length + 1}) as value, substr(owner, ${prefix.length + 1}) as label from vaults
        where owner like ${prefix + "%"} and lower(substr(owner, ${prefix.length + 1})) like ${q}
        order by 1 limit 20`;
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/vaults/:id", async (req) => {
    requireAction(req, "admin.vaults");
    const v = await vaults.get(req.params.id);
    if (!v) throw new AuthError("not_found", "Vault non trovato.");
    return v;
  });

  app.post<{ Body: { kind: "cell" | "space"; slug: string; name: string; owner?: string; schemaMd?: string; defaultClassification?: number; vectorIndex?: VectorIndexKind } }>(
    "/api/admin/vaults",
    {
      schema: {
        body: {
          type: "object",
          required: ["kind", "slug", "name"],
          properties: {
            kind: { enum: ["cell", "space"] },
            slug: str(63),
            name: str(120),
            owner: { type: "string", pattern: "^(user|edge|team|project):[A-Za-z0-9_-]+$" },
            schemaMd: { type: "string", maxLength: 100000 },
            defaultClassification: { type: "integer", minimum: 0, maximum: PERSONAL },
            vectorIndex: { enum: ["binary", "full", "none"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      requireAction(req, "admin.vaults");
      const owner = req.body.owner === undefined ? {} : { owner: await resolveOwner(req.body.owner) };
      const dc = vaultDefault(owner.owner ?? null, req.body.defaultClassification);
      try {
        const v = await vaults.create({ ...req.body, ...owner, defaultClassification: dc });
        await audit(req, "admin.vault.create", v.id, { slug: v.slug, kind: v.kind });
        return reply.status(201).send(v);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new AuthError("conflict", `Il vault "${req.body.slug}" esiste già.`);
        if (/invalid vault slug/.test(String(e))) throw new AuthError("invalid_request", "Identificativo non valido: lettere minuscole, cifre e trattini.");
        throw e;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; owner?: string | null; schemaMd?: string; defaultClassification?: number; vectorIndex?: VectorIndexKind } }>(
    "/api/admin/vaults/:id",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          properties: {
            name: str(120),
            owner: { anyOf: [{ type: "string", pattern: "^(user|edge|team|project):[A-Za-z0-9_-]+$" }, { type: "null" }] },
            schemaMd: { type: "string", maxLength: 100000 },
            defaultClassification: { type: "integer", minimum: 0, maximum: PERSONAL }, vectorIndex: { enum: ["binary", "full", "none"] } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      requireAction(req, "admin.vaults");
      const v = await vaults.get(req.params.id);
      if (!v) throw new AuthError("not_found", "Vault non trovato.");
      const { vectorIndex, ...rest } = req.body;
      if ("owner" in rest) {
        rest.owner = await resolveOwner(rest.owner ?? null);
        // personal content belongs to its owner: it never moves to another one
        if (rest.owner !== v.owner) {
          const [p] = await auth.sql`
            select 1 from pages where vault_id = ${v.id} and classification = ${PERSONAL}
            union all select 1 from sources where vault_id = ${v.id} and classification = ${PERSONAL} limit 1`;
          if (p) throw new AuthError("conflict", "Il vault contiene contenuti personali del proprietario: non può cambiare proprietario.");
        }
      }
      const owner = "owner" in rest ? (rest.owner ?? null) : v.owner;
      const wantedDc = rest.defaultClassification ?? (v.defaultClassification === PERSONAL && !isPersonalOwner(owner) ? FORMER_PERSONAL_CLASSIFICATION : undefined);
      if (wantedDc === PERSONAL && !isPersonalOwner(owner)) throw new AuthError("invalid_request", "La classificazione «personale» vale solo nei vault personali.");
      if (wantedDc !== undefined) rest.defaultClassification = wantedDc;
      if (Object.keys(rest).length) {
        await auth.sql`
          update vaults set name = coalesce(${rest.name ?? null}, name), schema_md = coalesce(${rest.schemaMd ?? null}, schema_md),
                 default_classification = coalesce(${rest.defaultClassification ?? null}, default_classification),
                 owner = case when ${"owner" in rest} then ${rest.owner ?? null} else owner end, updated_at = now()
          where id = ${v.id}`;
      }
      if (vectorIndex && vectorIndex !== v.vectorIndex) await vaults.setVectorIndex(v.id, vectorIndex);
      await audit(req, "admin.vault.update", v.id, { changes: req.body });
      return vaults.get(v.id);
    },
  );

  app.delete<{ Params: { id: string }; Body: { confirm: string } }>(
    "/api/admin/vaults/:id",
    { schema: { body: { type: "object", required: ["confirm"], properties: { confirm: str(63) }, additionalProperties: false } } },
    async (req) => {
      requireAction(req, "admin.vaults");
      const v = await vaults.get(req.params.id);
      if (!v) throw new AuthError("not_found", "Vault non trovato.");
      if (req.body.confirm !== v.slug) throw new AuthError("invalid_request", "Per eliminare il vault scrivi il suo identificativo esatto nel campo di conferma.");
      // the encrypted original files go too: a deleted vault leaves no documents on disk
      if (ingest) await ingest.deleteVaultFiles(v.id);
      await vaults.delete(v.id);
      await audit(req, "admin.vault.delete", v.id, { slug: v.slug });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // Grants, sessions, audit
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { principalId?: string; vaultId?: string } }>(
    "/api/admin/grants",
    { schema: { querystring: { type: "object", properties: { principalId: str(64), vaultId: str(64) }, additionalProperties: false } } },
    async (req) => {
      requireAction(req, "admin.grants");
      return auth.access.matrix(req.query);
    },
  );

  app.put<{ Body: { principalId: string; vaultId: string; permission: Permission } }>(
    "/api/admin/grants",
    {
      schema: {
        body: {
          type: "object",
          required: ["principalId", "vaultId", "permission"],
          properties: { principalId: str(64), vaultId: str(64), permission: { enum: PERMISSIONS } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const a = requireAction(req, "admin.grants");
      if (!(await auth.principals.get(req.body.principalId))) throw new AuthError("not_found", "Account non trovato.");
      if (!(await vaults.get(req.body.vaultId))) throw new AuthError("not_found", "Vault non trovato.");
      await auth.access.grant(req.body.principalId, req.body.vaultId, req.body.permission, a.principal.id);
      await audit(req, "admin.grant.set", req.body.principalId, { vaultId: req.body.vaultId, permission: req.body.permission });
      return { ok: true };
    },
  );

  app.delete<{ Params: { principalId: string; vaultId: string } }>("/api/admin/grants/:principalId/:vaultId", async (req) => {
    requireAction(req, "admin.grants");
    if (!(await auth.access.revoke(req.params.principalId, req.params.vaultId))) throw new AuthError("not_found", "Permesso non trovato.");
    await audit(req, "admin.grant.revoke", req.params.principalId, { vaultId: req.params.vaultId });
    return { ok: true };
  });

  app.get<{ Querystring: { principalId?: string } }>("/api/admin/sessions", async (req) => {
    requireAction(req, "admin.sessions");
    return auth.sessions.list(req.query.principalId);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/sessions/:id", async (req) => {
    requireAction(req, "admin.sessions");
    if (!(await auth.sessions.revoke(req.params.id))) throw new AuthError("not_found", "Sessione non trovata.");
    await audit(req, "admin.session.revoke", req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { principalId?: string; action?: string; outcome?: string; since?: string; until?: string; beforeId?: number; limit?: number } }>(
    "/api/admin/audit",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            principalId: str(64),
            action: str(100),
            outcome: { enum: ["ok", "denied", "error"] },
            since: { type: "string", format: "date-time" },
            until: { type: "string", format: "date-time" },
            beforeId: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 1000 },
          },
        },
      },
    },
    async (req) => {
      requireAction(req, "admin.audit");
      await auth.audit.flush();
      const q = req.query;
      return auth.audit.query({ ...q, since: q.since ? new Date(q.since) : undefined, until: q.until ? new Date(q.until) : undefined });
    },
  );

  /** Integrity of the audit log: the hash chain of the security events (Garante, 27/11/2008). */
  app.get("/api/admin/audit/verify", async (req) => {
    requireAction(req, "admin.audit");
    await auth.audit.flush();
    const r = await verifyAuditChain(auth.sql);
    await audit(req, "admin.audit.verify", null, { rows: r.rows, broken: r.broken });
    return r;
  });
}
