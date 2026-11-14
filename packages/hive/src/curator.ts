/**
 * Curator queue (plan §3.2, §5 step 5 and 7): conflicts between cells, duplicate candidates,
 * lint findings and low-confidence statements. A decision on a conflict is applied to the
 * hive page at once and at every later promotion, until the values in the cells change.
 */
import type { Sql } from "@cb/db";
import { PageStore } from "@cb/brain";
import { promoteSpace, type Resolution } from "./promote.ts";

export interface CuratorItem {
  id: string;
  spaceId: string;
  kind: "conflict" | "duplicate" | "lint" | "low_confidence" | "proposal" | "mass_change" | "rectification";
  subject: string;
  predicate: string | null;
  pageId: string | null;
  data: Record<string, unknown>;
  status: "open" | "resolved" | "dismissed" | "superseded";
  resolution: Resolution | Record<string, unknown> | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

const COLS = `id, space_id as "spaceId", kind, subject, predicate, page_id as "pageId", data, status, resolution,
  resolved_by as "resolvedBy", resolved_at as "resolvedAt", created_at as "createdAt"`;

export class CuratorError extends Error {}

export class Curator {
  constructor(
    private readonly sql: Sql,
    private readonly pages: PageStore,
  ) {}

  async list(spaceIds: string[], o: { status?: string; kind?: string; limit?: number } = {}): Promise<CuratorItem[]> {
    if (!spaceIds.length) return [];
    return this.sql<CuratorItem[]>`
      select ${this.sql.unsafe(COLS)} from curator_items
      where space_id = any(${spaceIds}) and status = ${o.status ?? "open"} and (${o.kind ?? null}::text is null or kind = ${o.kind ?? null})
      order by created_at desc limit ${Math.min(o.limit ?? 200, 1000)}`;
  }

  async counts(spaceIds: string[]): Promise<Record<string, number>> {
    if (!spaceIds.length) return {};
    const rows = await this.sql<{ spaceId: string; n: number }[]>`
      select space_id as "spaceId", count(*)::int as n from curator_items where space_id = any(${spaceIds}) and status = 'open' group by 1`;
    return Object.fromEntries(rows.map((r) => [r.spaceId, r.n]));
  }

  async get(id: string): Promise<CuratorItem | undefined> {
    const [r] = await this.sql<CuratorItem[]>`select ${this.sql.unsafe(COLS)} from curator_items where id = ${id}`;
    return r;
  }

  /**
   * Decides an item. Conflicts: `choice` (one of the values), `custom` (a value written by the
   * curator) or `keepAll` (all the values are right, e.g. two sites). Other kinds: `done`.
   * A mass change confirmed with `done` runs now; dismissed, the pages stay.
   */
  async resolve(id: string, decision: Resolution | { done: true; note?: string }, by: string): Promise<CuratorItem> {
    const item = await this.get(id);
    if (!item) throw new CuratorError("Voce non trovata.");
    if (item.status !== "open") throw new CuratorError("La voce non è più aperta.");
    if (item.kind === "conflict") {
      if ("done" in decision) throw new CuratorError("Per un conflitto scegli un valore.");
      if ("choice" in decision) {
        const values = (item.data.values as { valueNorm: string }[] | undefined) ?? [];
        if (!values.some((v) => v.valueNorm === decision.choice)) throw new CuratorError("Il valore scelto non è tra quelli in conflitto.");
      }
      if ("custom" in decision && !decision.custom.trim()) throw new CuratorError("Scrivi il valore corretto.");
    }
    await this.sql`
      update curator_items set status = 'resolved', resolution = ${this.sql.json(decision as never)}, resolved_by = ${by}, resolved_at = now()
      where id = ${id}`;
    if (item.kind === "conflict") await promoteSpace(this.sql, this.pages, item.spaceId, { subjects: [item.subject] });
    if (item.kind === "mass_change" && item.data.action === "remove") {
      await promoteSpace(this.sql, this.pages, item.spaceId, { cleanup: true, confirmedRemovals: (item.data.subjects as string[] | undefined) ?? [] });
    }
    return (await this.get(id))!;
  }

  /**
   * Applies an edit proposed by the cloud agent. The page must still be at the version the proposal was
   * written on; otherwise the proposal is superseded and must be made again.
   */
  async applyProposal(id: string, by: string): Promise<{ pageId: string; version: number }> {
    const item = await this.get(id);
    if (!item || item.kind !== "proposal") throw new CuratorError("Proposta non trovata.");
    if (item.status !== "open") throw new CuratorError("La proposta non è più aperta.");
    const d = item.data as { pageId: string; baseVersion: number; body: string };
    const page = await PageStore.get(this.sql, d.pageId);
    if (!page) throw new CuratorError("La pagina non esiste più.");
    if (page.version !== d.baseVersion) {
      await this.sql`update curator_items set status = 'superseded' where id = ${id}`;
      throw new CuratorError(`La pagina è cambiata dopo la proposta (versione ${page.version}, la proposta era sulla ${d.baseVersion}).`);
    }
    const r = await this.pages.upsert({ vaultId: page.vaultId, id: page.id, path: page.path, frontmatter: page.frontmatter, body: d.body, author: by });
    await this.sql`
      update curator_items set status = 'resolved', resolution = ${this.sql.json({ applied: true, version: r.page.version } as never)}, resolved_by = ${by}, resolved_at = now()
      where id = ${id}`;
    return { pageId: page.id, version: r.page.version };
  }

  async dismiss(id: string, by: string, note?: string): Promise<CuratorItem> {
    const item = await this.get(id);
    if (!item) throw new CuratorError("Voce non trovata.");
    if (item.status !== "open") throw new CuratorError("La voce non è più aperta.");
    // a dismissed conflict keeps every value, like `keepAll`
    await this.sql`
      update curator_items set status = ${item.kind === "conflict" ? "resolved" : "dismissed"},
             resolution = ${this.sql.json((item.kind === "conflict" ? { keepAll: true, note: note ?? null } : { note: note ?? null }) as never)},
             resolved_by = ${by}, resolved_at = now()
      where id = ${id}`;
    if (item.kind === "conflict") await promoteSpace(this.sql, this.pages, item.spaceId, { subjects: [item.subject] });
    return (await this.get(id))!;
  }
}
