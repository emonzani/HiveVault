import type { Sql } from "@cb/db";
import { newId } from "@cb/shared";
import { AuthError } from "./errors.ts";

/** "team": a group of users. It never logs in; its grants and owned vaults reach its members. */
export type PrincipalKind = "user" | "api" | "team";
export type Role = "admin" | "curator" | "member" | "api" | "team";
/** "projects": project documentation of coding agents (routes/projects.ts), nothing else. */
export type Scope = "read" | "write" | "ingest" | "admin" | "projects";
export const SCOPES: Scope[] = ["read", "write", "ingest", "admin", "projects"];

export interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  name: string;
  displayName: string;
  email: string | null;
  role: Role;
  scopes: Scope[];
  clearance: number;
  status: "active" | "suspended";
  expiresAt: Date | null;
  allowedIps: string[] | null;
  ratePerMin: number | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
  /** API accounts only: the user the key acts for (its permissions bound the key's). */
  userId: string | null;
}

/** Principal columns in camelCase, optionally qualified with a table alias. */
export function principalCols(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return [
    `${p}id`, `${p}kind`, `${p}name`, `${p}display_name as "displayName"`, `${p}email`, `${p}role`, `${p}scopes`, `${p}clearance`,
    `${p}status`, `${p}expires_at as "expiresAt"`, `${p}allowed_ips::text[] as "allowedIps"`, `${p}rate_per_min as "ratePerMin"`,
    `${p}created_by as "createdBy"`, `${p}created_at as "createdAt"`, `${p}updated_at as "updatedAt"`, `${p}last_seen_at as "lastSeenAt"`,
    `${p}user_id as "userId"`,
  ].join(", ");
}
export const PRINCIPAL_COLS = principalCols();

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export interface CreateUser {
  username: string;
  displayName: string;
  email?: string | null;
  role?: Exclude<Role, "api">;
  clearance?: number;
  createdBy?: string | null;
}

export interface CreateApiAccount {
  name: string;
  displayName?: string;
  scopes: Scope[];
  clearance?: number;
  expiresAt?: Date | null;
  allowedIps?: string[] | null;
  ratePerMin?: number | null;
  createdBy?: string | null;
  /** The user the key acts for: the key never reaches more than this user may. */
  userId?: string | null;
}

export interface CreateTeam {
  name: string;
  displayName?: string;
  createdBy?: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  displayName: string;
  addedAt: Date;
}

export interface UpdatePrincipal {
  displayName?: string;
  email?: string | null;
  role?: Role;
  scopes?: Scope[];
  clearance?: number;
  status?: "active" | "suspended";
  expiresAt?: Date | null;
  allowedIps?: string[] | null;
  ratePerMin?: number | null;
}

/** People and API accounts. Uniqueness and constraints are enforced by the database too. */
export class Principals {
  constructor(private readonly sql: Sql) {}

  async createUser(u: CreateUser): Promise<PrincipalRow> {
    const name = u.username.trim().toLowerCase();
    if (!USERNAME.test(name)) throw new AuthError("invalid_request", "Nome utente non valido: usa lettere minuscole, cifre, punto, trattino (2–63 caratteri).");
    return this.insert({
      id: newId("usr"),
      kind: "user",
      name,
      display_name: u.displayName.trim() || name,
      email: u.email ?? null,
      role: u.role ?? "member",
      scopes: [],
      clearance: u.clearance ?? 1,
      created_by: u.createdBy ?? null,
    });
  }

  async createApiAccount(a: CreateApiAccount): Promise<PrincipalRow> {
    const name = a.name.trim().toLowerCase();
    if (!USERNAME.test(name)) throw new AuthError("invalid_request", "Nome dell'account API non valido.");
    if (!a.scopes.length || a.scopes.some((s) => !SCOPES.includes(s))) throw new AuthError("invalid_request", "Ambiti non validi.");
    if (a.userId) {
      const u = await this.get(a.userId);
      if (!u || u.kind !== "user") throw new AuthError("invalid_request", "L'account API si può legare solo a un utente.");
    }
    return this.insert({
      user_id: a.userId ?? null,
      id: newId("api"),
      kind: "api",
      name,
      display_name: a.displayName?.trim() || name,
      email: null,
      role: "api",
      scopes: a.scopes,
      clearance: a.clearance ?? 1,
      expires_at: a.expiresAt ?? null,
      allowed_ips: a.allowedIps ?? null,
      rate_per_min: a.ratePerMin ?? null,
      created_by: a.createdBy ?? null,
    });
  }

  async createTeam(t: CreateTeam): Promise<PrincipalRow> {
    const name = t.name.trim().toLowerCase();
    if (!USERNAME.test(name)) throw new AuthError("invalid_request", "Nome del team non valido: usa lettere minuscole, cifre, punto, trattino (2–63 caratteri).");
    return this.insert({
      id: newId("team"),
      kind: "team",
      name,
      display_name: t.displayName?.trim() || name,
      email: null,
      role: "team",
      scopes: [],
      clearance: 0,
      created_by: t.createdBy ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Team members: users only, any number of teams each
  // ---------------------------------------------------------------------------
  async addMember(teamId: string, userId: string, by: string | null): Promise<void> {
    const [team, user] = await Promise.all([this.get(teamId), this.get(userId)]);
    if (!team || team.kind !== "team") throw new AuthError("not_found", "Team non trovato.");
    if (!user || user.kind !== "user") throw new AuthError("invalid_request", "Solo gli utenti possono essere membri di un team.");
    await this.sql`
      insert into team_members (team_id, member_id, added_by) values (${teamId}, ${userId}, ${by})
      on conflict (team_id, member_id) do nothing`;
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    const r = await this.sql`delete from team_members where team_id = ${teamId} and member_id = ${userId}`;
    return r.count > 0;
  }

  async members(teamId: string): Promise<TeamMember[]> {
    return this.sql<TeamMember[]>`
      select p.id, p.name, p.display_name as "displayName", m.added_at as "addedAt"
      from team_members m join principals p on p.id = m.member_id
      where m.team_id = ${teamId} order by p.display_name`;
  }

  /** The teams of a user, oldest membership first. */
  async teamsOf(userId: string): Promise<{ id: string; name: string; displayName: string }[]> {
    return this.sql<{ id: string; name: string; displayName: string }[]>`
      select p.id, p.name, p.display_name as "displayName"
      from team_members m join principals p on p.id = m.team_id
      where m.member_id = ${userId} order by m.added_at, p.name`;
  }

  private async insert(row: Record<string, unknown>): Promise<PrincipalRow> {
    try {
      const [p] = await this.sql<PrincipalRow[]>`
        insert into principals ${this.sql(row as never)} returning ${this.sql.unsafe(PRINCIPAL_COLS)}`;
      return p!;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AuthError("conflict", `Il nome "${row.name}" è già in uso.`);
      if ((e as { code?: string }).code === "23514") throw new AuthError("invalid_request", "Valori non validi.");
      throw e;
    }
  }

  async get(id: string): Promise<PrincipalRow | undefined> {
    const [p] = await this.sql<PrincipalRow[]>`select ${this.sql.unsafe(PRINCIPAL_COLS)} from principals where id = ${id}`;
    return p;
  }

  async getByName(name: string): Promise<PrincipalRow | undefined> {
    const [p] = await this.sql<PrincipalRow[]>`select ${this.sql.unsafe(PRINCIPAL_COLS)} from principals where name = ${name.trim().toLowerCase()}`;
    return p;
  }

  async list(o: { kind?: PrincipalKind; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: PrincipalRow[]; total: number }> {
    const q = o.q ? `%${o.q.toLowerCase()}%` : null;
    const items = await this.sql<PrincipalRow[]>`
      select ${this.sql.unsafe(PRINCIPAL_COLS)} from principals
      where (${o.kind ?? null}::text is null or kind = ${o.kind ?? null})
        and (${q}::text is null or name like ${q} or lower(display_name) like ${q} or lower(coalesce(email, '')) like ${q})
      order by kind, name limit ${o.limit ?? 100} offset ${o.offset ?? 0}`;
    const [{ n }] = (await this.sql`
      select count(*)::int as n from principals
      where (${o.kind ?? null}::text is null or kind = ${o.kind ?? null})
        and (${q}::text is null or name like ${q} or lower(display_name) like ${q} or lower(coalesce(email, '')) like ${q})`) as unknown as [{ n: number }];
    return { items, total: n };
  }

  async update(id: string, p: UpdatePrincipal): Promise<PrincipalRow> {
    const cur = await this.get(id);
    if (!cur) throw new AuthError("not_found", "Account non trovato.");
    if (p.role && ((p.role === "api") !== (cur.kind === "api") || (p.role === "team") !== (cur.kind === "team"))) {
      throw new AuthError("invalid_request", "Ruolo non compatibile con il tipo di account.");
    }
    if (p.scopes && p.scopes.some((s) => !SCOPES.includes(s))) throw new AuthError("invalid_request", "Ambiti non validi.");
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (p.displayName !== undefined) set.display_name = p.displayName;
    if (p.email !== undefined) set.email = p.email;
    if (p.role !== undefined) set.role = p.role;
    if (p.scopes !== undefined) set.scopes = p.scopes;
    if (p.clearance !== undefined) set.clearance = p.clearance;
    if (p.status !== undefined) set.status = p.status;
    if (p.expiresAt !== undefined) set.expires_at = p.expiresAt;
    if (p.allowedIps !== undefined) set.allowed_ips = p.allowedIps;
    if (p.ratePerMin !== undefined) set.rate_per_min = p.ratePerMin;
    try {
      const [row] = await this.sql<PrincipalRow[]>`
        update principals set ${this.sql(set as never)} where id = ${id} returning ${this.sql.unsafe(PRINCIPAL_COLS)}`;
      return row!;
    } catch (e) {
      if ((e as { code?: string }).code === "23514") throw new AuthError("invalid_request", "Valori non validi.");
      throw e;
    }
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.sql`delete from principals where id = ${id}`;
    return r.count > 0;
  }

  async countAdmins(): Promise<number> {
    const [{ n }] = (await this.sql`select count(*)::int as n from principals where role = 'admin' and status = 'active'`) as unknown as [{ n: number }];
    return n;
  }

  async touch(id: string): Promise<void> {
    await this.sql`update principals set last_seen_at = now() where id = ${id} and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`;
  }
}

/** A principal can act when it is active and (for API accounts) not expired. */
export function isUsable(p: PrincipalRow, now = new Date()): boolean {
  return p.status === "active" && (!p.expiresAt || p.expiresAt > now);
}
