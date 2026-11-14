/**
 * Links during the day (M1): one durable task that wakes every few minutes and, for every vault
 * with pages written since its last pass, does the steps of the dream cycle that need no model:
 *
 * 1. crosslink of the changed pages, and of older pages that write a name new since then;
 * 2. claims of the changed pages and promotion to the hive spaces the vault feeds, only for
 *    the subjects of those pages.
 *
 * A new document is linked and in the hive minutes after its compilation, not the next night.
 * Removals of hive pages, duplicates, lint and the model steps stay in the dream cycle. Every
 * step is idempotent: a pass that runs twice, or at the same time as the dream cycle, leaves
 * the same pages. The pages this task writes make their vault "changed" again: the next pass
 * looks at them and finds nothing to do.
 */
import type { Sql } from "@cb/db";
import type { PageStore } from "@cb/brain";
import { metrics } from "@cb/shared";
import { defineTask, type TaskDefinition } from "@cb/tasks";
import { crosslinkBatch, type CrosslinkCursor } from "./maintenance.ts";
import { promoteSpace } from "./promote.ts";

export interface LinkDeps {
  sql: Sql;
  pages: PageStore;
  /** Pause between two passes (ms). */
  intervalMs: number;
  /** Task name (default "links"). Tests sharing one database use unique names. */
  name?: string;
  /** Only these vaults (tests sharing one database); default every vault. */
  vaultIds?: string[];
}

export interface LinkState {
  /** Database time of the first pass: vaults never seen are looked at from there. */
  started: string | null;
  /** Database time up to which every vault is done. */
  since: Record<string, string>;
  /** Vaults of the current pass still to do. */
  queue: string[];
  /** Crosslink batch of the first vault of the queue. */
  cursor: CrosslinkCursor | null;
}

export type LinkTask = TaskDefinition<Record<string, never>, LinkState, null>;

/**
 * Normalized subjects of the hive touched by the pages of `vaultId` changed in (since, until]:
 * their names, and the titles of the pages that share one of those names (a hive subject takes
 * the title of one page of its group).
 */
export async function touchedSubjects(sql: Sql, vaultId: string, since: string, until: string, cells: string[]): Promise<string[]> {
  const rows = await sql<{ s: string }[]>`
    with names as (
      select a.alias_norm from aliases a join pages p on p.id = a.page_id
      where p.vault_id = ${vaultId} and p.updated_at > ${since}::timestamptz and p.updated_at <= ${until}::timestamptz
    )
    select alias_norm as s from names
    union
    select t.alias_norm from aliases t
    where t.is_title and t.vault_id = any(${cells}) and t.page_id in (select a.page_id from aliases a where a.vault_id = any(${cells}) and a.alias_norm in (select alias_norm from names))`;
  return rows.map((r) => r.s);
}

export function defineLinkTask(d: LinkDeps): LinkTask {
  return defineTask<Record<string, never>, LinkState, null>({
    name: d.name ?? "links",
    version: 1,
    firstPhase: "tick",
    initial: () => ({ started: null, since: {}, queue: [], cursor: null }),
    phases: {
      async tick(ctx) {
        let s = ctx.task.state;
        if (!s.started) s = { ...s, started: (await d.sql<{ t: string }[]>`select now()::text as t`)[0]!.t };
        if (!s.queue.length) {
          // vaults written since their last pass: every page write bumps vaults.updated_at in its
          // own transaction (bumpVersion), so the vault row is as late as its newest page
          const dirty = await d.sql<{ id: string }[]>`
            select id from vaults where (${!d.vaultIds} or id = any(${d.vaultIds ?? []}))
              and updated_at > coalesce(${d.sql.json(s.since as never)}::jsonb ->> id, ${s.started})::timestamptz
            order by id`;
          if (!dirty.length) return ctx.sleepUntil(new Date(Date.now() + d.intervalMs), "tick", s);
          return ctx.next("tick", { ...s, queue: dirty.map((r) => r.id), cursor: null });
        }

        const vaultId = s.queue[0]!;
        const since = s.since[vaultId] ?? s.started!;
        const t0 = Date.now();
        const r = await crosslinkBatch(d.sql, d.pages, vaultId, s.cursor, since);
        metrics.inc("links_added", {}, r.report["link aggiunti"] ?? 0);
        if (!r.done) return ctx.next("tick", { ...s, cursor: r.cursor });

        // claims and hive: only the subjects of the changed pages, in every space the vault feeds
        const until = r.cursor.until!;
        const spaces = await d.sql<{ spaceId: string }[]>`select space_id as "spaceId" from hive_feeds where cell_id = ${vaultId} order by space_id`;
        let written = 0;
        for (const { spaceId } of spaces) {
          const cells = (await d.sql<{ c: string }[]>`select cell_id as c from hive_feeds where space_id = ${spaceId}`).map((x) => x.c);
          const subjects = await touchedSubjects(d.sql, vaultId, since, until, cells);
          if (!subjects.length) continue;
          const p = await promoteSpace(d.sql, d.pages, spaceId, { subjects });
          written += p.written;
        }
        metrics.observe("links_vault_ms", Date.now() - t0);
        if (r.report["pagine modificate"] || written) {
          ctx.log.info("links updated", { vaultId, links: r.report["link aggiunti"], pages: r.report["pagine modificate"], hive: written });
        }
        return ctx.next("tick", { ...s, since: { ...s.since, [vaultId]: until }, queue: s.queue.slice(1), cursor: null });
      },
    },
  });
}
