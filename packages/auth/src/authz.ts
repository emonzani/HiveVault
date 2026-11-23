/**
 * Authorization (plan §8.2): one function decides, for REST, MCP and jobs alike.
 *
 *   role admin            every vault (admin), but never the "personale" content of others
 *   role curator/member   their grants + the grants of their teams + their own cell vaults
 *                         (owner "user:<id>" = admin) + the vaults of their teams (owner
 *                         "team:<id>" = write)
 *   API account           its grants and, when bound to a user (`user_id`), what that user may
 *                         (not the user's personal vaults); capped by its scopes (read -> read,
 *                         write/ingest -> write, projects -> write on project vaults and nothing
 *                         elsewhere, admin scope -> admin API) and by the user's clearance
 *   team                  never acts: its grants reach its members
 *
 * "personale" content is read only in `personal`: the user's own personal vaults. Not even an
 * administrator reads it, and an API account never has personal vaults.
 *
 * The list of readable vaults computed here is the same list given to Row Level Security
 * (`toReader`), so the application filter and the database filter cannot disagree.
 */
import type { Sql } from "@cb/db";
import { isUsable, PRINCIPAL_COLS, type PrincipalRow } from "./principals.ts";
import { AuthError } from "./errors.ts";

export type Permission = "read" | "write" | "curate" | "admin";
export const PERMISSIONS: Permission[] = ["read", "write", "curate", "admin"];
const LEVEL: Record<Permission, number> = { read: 1, write: 2, curate: 3, admin: 4 };

export type Action =
  | "vault.read"
  | "vault.write"
  | "vault.curate"
  | "vault.admin"
  | "admin.users"
  | "admin.api"
  | "admin.vaults"
  | "admin.grants"
  | "admin.audit"
  | "admin.sessions"
  | "admin.ops";

export interface GrantRow {
  principalId: string;
  vaultId: string;
  permission: Permission;
  grantedBy: string | null;
  grantedAt: Date;
  principalName: string;
  principalKind: "user" | "api" | "team";
  principalRole: string;
  vaultName: string;
  vaultSlug: string;
  vaultKind: "cell" | "space";
}

export interface AccessContext {
  principal: PrincipalRow;
  isAdmin: boolean;
  /** Effective permission per vault id. */
  vaults: Map<string, Permission>;
  clearance: number;
  /** The user's own personal vaults (owner "user:<id>"): the only place it reads "personale". */
  personal: string[];
  /** Teams of the user. */
  teams: string[];
}

const VAULT_ACTION: Partial<Record<Action, Permission>> = {
  "vault.read": "read",
  "vault.write": "write",
  "vault.curate": "curate",
  "vault.admin": "admin",
};

/**
 * The highest permission an API account's scopes allow, on a project vault (owner
 * `project:<slug>`) and on any other. "projects" writes project vaults only, through the project
 * routes and the MCP inbox (`requireAction` refuses it everywhere else); it gives nothing on other
 * vaults: reading them needs the scope "read".
 */
export function apiCap(scopes: string[], projectVault: boolean): Permission | null {
  if (scopes.includes("write") || scopes.includes("ingest")) return "write";
  if (scopes.includes("projects") && projectVault) return "write";
  if (scopes.includes("read")) return "read";
  return null;
}

export class Access {
  constructor(private readonly sql: Sql) {}

  async context(principal: PrincipalRow): Promise<AccessContext> {
    const vaults = new Map<string, Permission>();
    const raise = (id: string, p: Permission) => {
      const have = vaults.get(id);
      if (!have || LEVEL[p] > LEVEL[have]) vaults.set(id, p);
    };
    if (principal.kind === "team") return { principal, isAdmin: false, vaults, clearance: -1, personal: [], teams: [] };
    if (principal.kind === "api") return this.apiContext(principal);
    const user = principal.kind === "user";
    const isAdmin = user ? principal.role === "admin" : principal.scopes.includes("admin");
    const teams = user ? (await this.sql<{ id: string }[]>`select team_id as id from team_members where member_id = ${principal.id}`).map((t) => t.id) : [];
    const personal = user ? (await this.sql<{ id: string }[]>`select id from vaults where owner = ${`user:${principal.id}`}`).map((v) => v.id) : [];
    if (user && principal.role === "admin") {
      for (const v of await this.sql<{ id: string }[]>`select id from vaults`) vaults.set(v.id, "admin");
    } else {
      const grants = await this.sql<{ vault_id: string; permission: Permission }[]>`
        select vault_id, permission from vault_grants where principal_id = any(${[principal.id, ...teams]})`;
      for (const g of grants) raise(g.vault_id, g.permission);
      if (teams.length) {
        for (const v of await this.sql<{ id: string }[]>`select id from vaults where owner = any(${teams.map((t) => `team:${t}`)})`) raise(v.id, "write");
      }
      for (const id of personal) vaults.set(id, "admin");
    }
    return { principal, isAdmin, vaults, clearance: principal.clearance, personal, teams };
  }

  /**
   * An API account: its own grants, and, when it is bound to a user, what that user may (team
   * grants included). Each vault is capped by the scopes (`apiCap`). The user's personal vaults
   * (`user:…`) do not pass to the key, and a suspended or expired user leaves the key with nothing.
   */
  private async apiContext(principal: PrincipalRow): Promise<AccessContext> {
    const vaults = new Map<string, Permission>();
    const empty = { principal, isAdmin: principal.scopes.includes("admin"), vaults, clearance: principal.clearance, personal: [], teams: [] };
    const have = new Map<string, Permission>();
    const raise = (id: string, p: Permission) => {
      const h = have.get(id);
      if (!h || LEVEL[p] > LEVEL[h]) have.set(id, p);
    };
    for (const g of await this.sql<{ vault_id: string; permission: Permission }[]>`
      select vault_id, permission from vault_grants where principal_id = ${principal.id}`) raise(g.vault_id, g.permission);
    const own = new Set(have.keys());
    const inherited = new Set<string>();
    let clearance = principal.clearance;
    if (principal.userId) {
      const [owner] = await this.sql<PrincipalRow[]>`select ${this.sql.unsafe(PRINCIPAL_COLS)} from principals where id = ${principal.userId}`;
      if (!owner || owner.kind !== "user" || !isUsable(owner)) return { ...empty, isAdmin: false };
      const o = await this.context(owner);
      for (const [id, p] of o.vaults) if (!own.has(id)) inherited.add(id), raise(id, p);
      clearance = Math.min(clearance, owner.clearance);
    }
    if (have.size) {
      const owners = await this.sql<{ id: string; owner: string | null }[]>`select id, owner from vaults where id = any(${[...have.keys()]})`;
      for (const v of owners) {
        // personal cells come to a key only by an explicit grant, never from its user
        if (inherited.has(v.id) && v.owner?.startsWith("user:")) continue;
        const cap = apiCap(principal.scopes, !!v.owner?.startsWith("project:"));
        const p = have.get(v.id)!;
        if (cap) vaults.set(v.id, LEVEL[p] <= LEVEL[cap] ? p : cap);
      }
    }
    return { ...empty, clearance };
  }

  static can(ctx: AccessContext, action: Action, vaultId?: string): boolean {
    const need = VAULT_ACTION[action];
    if (need) {
      if (!vaultId) return false;
      const have = ctx.vaults.get(vaultId);
      return !!have && LEVEL[have] >= LEVEL[need];
    }
    // admin.* actions: system administrators (users with role admin, API accounts with scope admin)
    return ctx.isAdmin;
  }

  static require(ctx: AccessContext, action: Action, vaultId?: string): void {
    if (!Access.can(ctx, action, vaultId)) throw new AuthError("forbidden", "Non hai i permessi per questa operazione.");
  }

  /** Principal for the reader role (search, read): readable vaults + clearance. */
  static toReader(ctx: AccessContext, only?: string[]): { id: string; vaults: string[]; clearance: number; personal: string[] } {
    const readable = [...ctx.vaults.keys()].filter((v) => !only || only.includes(v));
    return { id: ctx.principal.id, vaults: readable, clearance: ctx.clearance, personal: ctx.personal.filter((v) => readable.includes(v)) };
  }

  /**
   * The reader of a stored principal, for a job that works for it after the request (the
   * attachments of an upload), or null when the principal no longer exists or acts.
   */
  async readerOf(principalId: string): Promise<ReturnType<typeof Access.toReader> | null> {
    const [p] = await this.sql<PrincipalRow[]>`select ${this.sql.unsafe(PRINCIPAL_COLS)} from principals where id = ${principalId}`;
    return p && isUsable(p) ? Access.toReader(await this.context(p)) : null;
  }

  /** True in the principal's own personal vault: only there it may set or change "personale". */
  static ownsPersonal(ctx: AccessContext, vaultId: string): boolean {
    return ctx.personal.includes(vaultId);
  }

  // ---------------------------------------------------------------------------
  // Grants
  // ---------------------------------------------------------------------------
  async grant(principalId: string, vaultId: string, permission: Permission, by: string | null): Promise<void> {
    if (!PERMISSIONS.includes(permission)) throw new AuthError("invalid_request", "Permesso non valido.");
    await this.sql`
      insert into vault_grants (principal_id, vault_id, permission, granted_by) values (${principalId}, ${vaultId}, ${permission}, ${by})
      on conflict (principal_id, vault_id) do update set permission = excluded.permission, granted_by = excluded.granted_by, granted_at = now()`;
  }

  async revoke(principalId: string, vaultId: string): Promise<boolean> {
    const r = await this.sql`delete from vault_grants where principal_id = ${principalId} and vault_id = ${vaultId}`;
    return r.count > 0;
  }

  /** The principal × vault matrix for the admin console. */
  /** Grants with the names the console shows, optionally of one principal or one vault. */
  async matrix(f: { principalId?: string; vaultId?: string } = {}): Promise<GrantRow[]> {
    return this.sql`
      select g.principal_id as "principalId", g.vault_id as "vaultId", g.permission, g.granted_by as "grantedBy", g.granted_at as "grantedAt",
             p.display_name as "principalName", p.kind as "principalKind", p.role as "principalRole", v.name as "vaultName", v.slug as "vaultSlug", v.kind as "vaultKind"
      from vault_grants g join principals p on p.id = g.principal_id join vaults v on v.id = g.vault_id
      where (${f.principalId ?? null}::text is null or g.principal_id = ${f.principalId ?? null})
        and (${f.vaultId ?? null}::text is null or g.vault_id = ${f.vaultId ?? null})
      order by v.name, p.display_name`;
  }
}
