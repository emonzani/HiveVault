/**
 * Hive and dream cycle: curator queue (decisions on conflicts, duplicate merges), cells that
 * feed a space, reports of the nightly cycle, generated indexes (llms.txt), manual start.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Access, AuthError, type AuthService } from "@cb/auth";
import { withReader, type PageStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { Curator, CuratorError, DreamBusyError, DreamVaultError, feedsOf, mergePages, MergeVisibilityError, renderIndexes, setFeeds, startDream, type DreamTask } from "@cb/hive";
import type { TaskEngine } from "@cb/tasks";
import { meta, requireAction, requireAuth, requireUser } from "../http.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;

export interface HiveDeps {
  curator: Curator;
  pages: PageStore;
  engine?: TaskEngine;
  dream?: DreamTask;
  dreamWindow?: string;
}

export function hiveRoutes(app: FastifyInstance, sql: Sql, auth: AuthService, d: HiveDeps): void {
  /** Vaults where the caller curates (curate or admin permission). */
  const curated = (req: FastifyRequest) => {
    const a = requireUser(req);
    return { a, ids: [...a.ctx.vaults.keys()].filter((v) => Access.can(a.ctx, "vault.curate", v)) };
  };

  async function item(req: FastifyRequest, id: string) {
    const a = requireUser(req);
    const it = await d.curator.get(id);
    if (!it || !Access.can(a.ctx, "vault.curate", it.spaceId)) throw new AuthError("not_found", "Voce non trovata.");
    return { a, it };
  }

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CuratorError || e instanceof MergeVisibilityError) throw new AuthError("invalid_request", e.message);
      throw e;
    }
  };

  app.get<{ Querystring: { status?: string; kind?: string; vault?: string } }>(
    "/api/curator",
    { schema: { querystring: { type: "object", properties: { status: { enum: ["open", "resolved", "dismissed", "superseded"] }, kind: str(20), vault: str(64) } } } },
    async (req) => {
      const { a, ids } = curated(req);
      const spaces = req.query.vault ? ids.filter((v) => v === req.query.vault) : ids;
      const items = await d.curator.list(spaces, { ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.kind ? { kind: req.query.kind } : {}) });
      // an item tied to a page the caller cannot read (classification) is not shown
      const pageIds = [...new Set(items.map((i) => i.pageId).filter((x): x is string => !!x))];
      const visible = new Set(
        pageIds.length
          ? (await withReader(sql, Access.toReader(a.ctx), (tx) => tx<{ id: string }[]>`select id from pages where id = any(${pageIds})`)).map((r) => r.id)
          : [],
      );
      const names = new Map((await sql<{ id: string; name: string }[]>`select id, name from vaults where id = any(${spaces})`).map((v) => [v.id, v.name]));
      // rectifications list the cited pages and documents: only those the caller may read
      type Ref = { id: string };
      const rect = items.filter((i) => i.kind === "rectification");
      const refIds = rect.flatMap((i) => [...((i.data.pages as Ref[] | undefined) ?? []), ...((i.data.sources as Ref[] | undefined) ?? [])].map((r) => r.id));
      const readable = new Set(
        refIds.length
          ? (await withReader(sql, Access.toReader(a.ctx), (tx) => tx<{ id: string }[]>`
              select id from pages where id = any(${refIds}) union select id from sources where id = any(${refIds})`)).map((r) => r.id)
          : [],
      );
      const only = (list: unknown) => ((list as Ref[] | undefined) ?? []).filter((r) => readable.has(r.id));
      return items
        .filter((i) => !i.pageId || visible.has(i.pageId))
        .map((i) => ({
          ...i,
          ...(i.kind === "rectification" ? { data: { ...i.data, pages: only(i.data.pages), sources: only(i.data.sources) } } : {}),
          vaultName: names.get(i.spaceId) ?? i.spaceId,
        }));
    },
  );

  app.get("/api/curator/counts", async (req) => {
    const { ids } = curated(req);
    const counts = await d.curator.counts(ids);
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byVault: counts, curates: ids.length > 0 };
  });

  app.post<{ Params: { id: string }; Body: { choice?: string; custom?: string; keepAll?: boolean } }>(
    "/api/curator/:id/resolve",
    { schema: { body: { type: "object", properties: { choice: str(500), custom: str(500), keepAll: { type: "boolean" } }, additionalProperties: false } } },
    async (req) => {
      const { a, it } = await item(req, req.params.id);
      const b = req.body;
      const decision = b.choice ? { choice: b.choice } : b.custom ? { custom: b.custom.trim() } : b.keepAll ? { keepAll: true as const } : null;
      if (!decision && it.kind === "conflict") throw new AuthError("invalid_request", "Scegli un valore, scrivine uno o tieni tutti i valori.");
      const r = await wrap(() => d.curator.resolve(it.id, decision ?? { done: true }, a.principal.id));
      await auth.audit.writeNow({ principalId: a.principal.id, action: "curator.resolve", resource: it.id, ...meta(req), data: { space: it.spaceId, kind: it.kind, decision } });
      return r;
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/curator/:id/dismiss",
    { schema: { body: { type: "object", properties: { note: { type: "string", maxLength: 500 } }, additionalProperties: false } } },
    async (req) => {
      const { a, it } = await item(req, req.params.id);
      const r = await wrap(() => d.curator.dismiss(it.id, a.principal.id, req.body?.note));
      await auth.audit.writeNow({ principalId: a.principal.id, action: "curator.dismiss", resource: it.id, ...meta(req), data: { space: it.spaceId, kind: it.kind } });
      return r;
    },
  );

  /** Duplicate candidates: merge the two pages, keeping the one the curator chose. */
  app.post<{ Params: { id: string }; Body: { keep: string } }>(
    "/api/curator/:id/merge",
    { schema: { body: { type: "object", required: ["keep"], properties: { keep: str(64) }, additionalProperties: false } } },
    async (req) => {
      const { a, it } = await item(req, req.params.id);
      if (it.kind !== "duplicate" || it.status !== "open") throw new AuthError("invalid_request", "Questa voce non è un duplicato da unire.");
      const ids = [(it.data.a as { id: string }).id, (it.data.b as { id: string }).id];
      if (!ids.includes(req.body.keep)) throw new AuthError("invalid_request", "La pagina da tenere non fa parte della coppia.");
      Access.require(a.ctx, "vault.write", it.spaceId);
      const found = await sql<{ id: string }[]>`select id from pages where id = any(${ids}) and vault_id = ${it.spaceId}`;
      if (found.length < 2) {
        await sql`update curator_items set status = 'superseded' where id = ${it.id} and status = 'open'`;
        throw new AuthError("conflict", "Una delle due pagine non esiste più (già unita o rimossa). La voce è chiusa.");
      }
      const r = await wrap(() => mergePages(sql, d.pages, req.body.keep, ids.find((x) => x !== req.body.keep)!, `curator:${a.principal.id}`));
      await d.curator.resolve(it.id, { done: true, note: `unite in ${r.kept}` }, a.principal.id);
      await auth.audit.writeNow({ principalId: a.principal.id, action: "curator.merge", resource: it.id, ...meta(req), data: { kept: r.kept, removed: r.removed } });
      return r;
    },
  );

  /** Edits proposed by the cloud agent: applied by a person with write permission on the vault. */
  app.post<{ Params: { id: string } }>("/api/curator/:id/apply", async (req) => {
    const { a, it } = await item(req, req.params.id);
    if (it.kind !== "proposal") throw new AuthError("invalid_request", "Questa voce non è una proposta di modifica.");
    Access.require(a.ctx, "vault.write", it.spaceId);
    const r = await wrap(() => d.curator.applyProposal(it.id, a.principal.id));
    await auth.audit.writeNow({ principalId: a.principal.id, action: "curator.apply", resource: it.id, ...meta(req), data: r });
    return r;
  });

  // ---------------------------------------------------------------------------
  // Feeds of a space (administrators)
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/admin/vaults/:id/feeds", async (req) => {
    requireAction(req, "admin.vaults");
    return feedsOf(sql, req.params.id);
  });

  app.put<{ Params: { id: string }; Body: { feeds: { cellId: string; types?: string[] }[] } }>(
    "/api/admin/vaults/:id/feeds",
    {
      schema: {
        body: {
          type: "object",
          required: ["feeds"],
          properties: {
            feeds: {
              type: "array",
              maxItems: 1000,
              items: { type: "object", required: ["cellId"], properties: { cellId: str(64), types: { type: "array", maxItems: 10, items: str(40) } }, additionalProperties: false },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const a = requireAction(req, "admin.vaults");
      const ids = [req.params.id, ...req.body.feeds.map((f) => f.cellId)];
      const found = await sql<{ id: string; kind: string }[]>`select id, kind from vaults where id = any(${ids})`;
      const space = found.find((v) => v.id === req.params.id);
      if (!space) throw new AuthError("not_found", "Vault non trovato.");
      if (space.kind !== "space") throw new AuthError("invalid_request", "Solo uno spazio dell'alveare riceve informazioni dalle celle.");
      if (req.body.feeds.some((f) => !found.some((v) => v.id === f.cellId && v.kind === "cell"))) throw new AuthError("invalid_request", "Ogni sorgente deve essere una cella esistente.");
      await setFeeds(sql, req.params.id, req.body.feeds);
      await auth.audit.writeNow({ principalId: a.principal.id, action: "admin.vault.feeds", resource: req.params.id, ...meta(req), data: { feeds: req.body.feeds } });
      return feedsOf(sql, req.params.id);
    },
  );

  /** Starts the cycle of a vault now (outside the window too); the budget still applies. Body `{ full: true }`: every page, not only the changed ones. */
  app.post<{ Params: { id: string }; Body: { full?: unknown } | undefined }>(
    "/api/admin/vaults/:id/dream",
    async (req, reply) => {
      const a = requireAction(req, "admin.vaults");
      if (!d.engine || !d.dream) throw new AuthError("invalid_request", "Il ciclo notturno non è attivo in questo processo.");
      const full = req.body?.full === true;
      try {
        const r = await startDream(sql, d.dream, { vaultId: req.params.id, window: d.dreamWindow ?? "22:00-06:00", full });
        await auth.audit.writeNow({ principalId: a.principal.id, action: "admin.vault.dream", resource: r.vaultId, data: { full }, ...meta(req) });
        return reply.status(202).send({ taskId: r.taskId, night: r.night });
      } catch (e) {
        if (e instanceof DreamBusyError) throw new AuthError("conflict", e.message);
        if (e instanceof DreamVaultError) throw new AuthError("not_found", e.message);
        throw e;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Reports and indexes (readers of the vault)
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: number } }>("/api/dream", { schema: { querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } } } }, async (req) => {
    const a = requireAuth(req);
    return withReader(sql, Access.toReader(a.ctx), (tx) => tx`
      select r.vault_id as "vaultId", v.name as "vaultName", v.kind, to_char(r.night, 'YYYY-MM-DD') as night, r.status, r.step, r.report, r.tokens,
             r.started_at as "startedAt", r.finished_at as "finishedAt"
      from dream_runs r join vaults v on v.id = r.vault_id
      order by r.night desc, v.kind, v.name limit ${req.query.limit ?? 60}`);
  });

  app.get<{ Params: { vaultId: string; name: string } }>("/api/vaults/:vaultId/index/:name", async (req, reply) => {
    requireAction(req, "vault.read", req.params.vaultId);
    if (!["index", "llms"].includes(req.params.name)) throw new AuthError("not_found", "Indice non trovato.");
    const a = requireAuth(req);
    // built under the caller's clearance: titles and summaries above it never appear
    const r = await withReader(sql, Access.toReader(a.ctx, [req.params.vaultId]), (tx) => renderIndexes(tx, req.params.vaultId));
    if (!r) throw new AuthError("not_found", "Vault non trovato.");
    reply.header("content-type", req.params.name === "llms" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8");
    return req.params.name === "llms" ? r.llms : r.index;
  });
}
