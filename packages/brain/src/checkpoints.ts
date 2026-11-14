/**
 * Safety of large changes (migration 013).
 *
 * - `isMassChange`: an automatic change (the dream cycle, an import) that would remove or rewrite
 *   more than a fifth of a vault stops and asks a person first.
 * - `CheckpointStore`: copies of the pages of a vault, and their restore. A restore first saves
 *   the current state as a checkpoint, so it can be undone. Hive pages are rebuilt by the dream
 *   cycle (invariant 15): checkpoints do not copy them and a restore does not touch them.
 */
import type { Sql } from "@cb/db";
import { newId } from "@cb/shared";
import { PageStore } from "./pages.ts";

/** Share of a vault an automatic change may remove or rewrite without asking. */
export const MASS_CHANGE_RATIO = 0.2;
/** Below this number of pages a change is never "mass" (small vaults change a lot at once). */
export const MASS_CHANGE_MIN = 5;

export function isMassChange(total: number, affected: number, o: { ratio?: number; min?: number } = {}): boolean {
  return affected > Math.max(o.min ?? MASS_CHANGE_MIN, (o.ratio ?? MASS_CHANGE_RATIO) * total);
}

export interface Checkpoint {
  id: string;
  vaultId: string;
  name: string;
  kind: "manual" | "auto";
  pages: number;
  createdBy: string | null;
  createdAt: Date;
}

export interface RestoreResult {
  /** Checkpoint with the state before the restore (undo). */
  undo: string;
  restored: number;
  removed: number;
  unchanged: number;
  /** Pages that could not come back (e.g. another page has their path now). */
  skipped: string[];
}

const COLS = `id, vault_id as "vaultId", name, kind, pages, created_by as "createdBy", created_at as "createdAt"`;
/** Automatic checkpoints kept per vault; manual ones stay until a person deletes them. */
const KEEP_AUTO = 5;
// "personale" pages are never copied, removed or overwritten by a checkpoint: an administrator
// restores vaults and must not see, nor destroy, the personal content of a person
const NOT_HIVE = `not (frontmatter ? 'hive_subject') and classification <> 4`;

export class CheckpointStore {
  constructor(
    private readonly sql: Sql,
    private readonly pages: PageStore,
  ) {}

  async list(vaultId: string): Promise<Checkpoint[]> {
    return this.sql<Checkpoint[]>`select ${this.sql.unsafe(COLS)} from vault_checkpoints where vault_id = ${vaultId} order by created_at desc, id desc limit 200`;
  }

  async get(id: string): Promise<Checkpoint | undefined> {
    const [c] = await this.sql<Checkpoint[]>`select ${this.sql.unsafe(COLS)} from vault_checkpoints where id = ${id}`;
    return c;
  }

  /** Copies every page of the vault (one statement: a consistent snapshot). */
  async create(vaultId: string, name: string, o: { by?: string | null; kind?: "manual" | "auto" } = {}): Promise<Checkpoint> {
    const id = newId("chk");
    const kind = o.kind ?? "manual";
    await this.sql.begin(async (tx) => {
      await tx`insert into vault_checkpoints (id, vault_id, name, kind, created_by) values (${id}, ${vaultId}, ${name.slice(0, 200)}, ${kind}, ${o.by ?? null})`;
      const [r] = await tx<{ n: number }[]>`
        with ins as (
          insert into vault_checkpoint_pages (checkpoint_id, page_id, path, version, hash, frontmatter, body)
          select ${id}, id, path, version, hash, frontmatter, body from pages where vault_id = ${vaultId} and ${tx.unsafe(NOT_HIVE)}
          returning 1)
        select count(*)::int as n from ins`;
      await tx`update vault_checkpoints set pages = ${r!.n} where id = ${id}`;
      if (kind === "auto") {
        await tx`
          delete from vault_checkpoints where id in (
            select id from vault_checkpoints where vault_id = ${vaultId} and kind = 'auto' order by created_at desc, id desc offset ${KEEP_AUTO})`;
      }
    });
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.sql`delete from vault_checkpoints where id = ${id}`).count > 0;
  }

  /**
   * Brings every page of the vault back to the checkpoint: changed pages get their old text (a
   * new version, the history stays), pages created later go, removed pages come back with their
   * old id. Links resolve again by id and title.
   */
  async restore(id: string, by: string | null): Promise<RestoreResult> {
    const cp = await this.get(id);
    if (!cp) throw new Error("checkpoint not found");
    const undo = await this.create(cp.vaultId, `Prima del ripristino di «${cp.name}»`, { by, kind: "auto" });
    const saved = await this.sql<{ pageId: string; path: string; hash: string; frontmatter: Record<string, unknown>; body: string }[]>`
      select page_id as "pageId", path, hash, frontmatter, body from vault_checkpoint_pages where checkpoint_id = ${id}`;
    const current = await this.sql<{ id: string; path: string; hash: string }[]>`
      select id, path, hash from pages where vault_id = ${cp.vaultId} and ${this.sql.unsafe(NOT_HIVE)}`;
    const keep = new Set(saved.map((s) => s.pageId));
    const res: RestoreResult = { undo: undo.id, restored: 0, removed: 0, unchanged: 0, skipped: [] };
    // first the pages created after the checkpoint: their paths may be needed again
    for (const c of current) {
      if (keep.has(c.id)) continue;
      if (await this.pages.delete(c.id)) res.removed++;
    }
    const byId = new Map(current.map((c) => [c.id, c]));
    const personal = await this.sql<{ id: string; path: string }[]>`select id, path from pages where vault_id = ${cp.vaultId} and classification = 4`;
    const personalIds = new Set(personal.map((p) => p.id));
    const personalPaths = new Set(personal.map((p) => p.path));
    for (const s of saved) {
      if (personalIds.has(s.pageId) || personalPaths.has(s.path)) {
        res.skipped.push(s.path);
        continue;
      }
      const now = byId.get(s.pageId);
      if (now && now.hash === s.hash && now.path === s.path) {
        res.unchanged++;
        continue;
      }
      try {
        await this.pages.upsert({ vaultId: cp.vaultId, id: s.pageId, path: s.path, frontmatter: s.frontmatter, body: s.body, author: `restore:${by ?? "system"}` });
        res.restored++;
      } catch {
        res.skipped.push(s.path);
      }
    }
    return res;
  }
}
