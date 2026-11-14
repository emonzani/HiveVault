/**
 * API of the user interface (plan §9.2): folders and page lists, full page, editor saves,
 * backlinks, history, suggestions, global graph, source text, inbox and review queue, the
 * notice about the cloud agent (D1) and the "Cosa ha letto l'agente cloud" panel.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Access, AuthError, type AuthService } from "@cb/auth";
import { openRectification, rectificationTargets, type RectificationTargets } from "@cb/hive";
import {
  backlinks,
  classificationLevel,
  folderCounts,
  fullPage,
  graph,
  listPages,
  PageStore,
  parseDocument,
  PERSONAL,
  recentPages,
  serializeDocument,
  sourceChunks,
  suggest,
  tagCounts,
  version,
  versions,
  withReader,
} from "@cb/brain";
import type { Sql } from "@cb/db";
import { meta, requireAction, requireAuth, requireUser } from "../http.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max }) as const;

/**
 * Pages written by the dream cycle: hive pages (rebuilt from the cells at every promotion) and
 * the maintenance page of the vault. An edit would be lost at the next night.
 */
const generated = (p: { frontmatter: Record<string, unknown>; path: string }) => typeof p.frontmatter.hive_subject === "string" || p.path.startsWith("_inbox/");

/**
 * Marks that only the dream cycle writes (invariant 15). In a page saved by a person they would
 * make it read-only for everyone, or pass it off as a hive page with a provenance it does not have.
 */
function reservedMarks(markdown: string): string | null {
  const fm = parseDocument(markdown).frontmatter;
  for (const k of ["hive_subject", "promoted_from"]) if (k in fm) return `«${k}» è scritto solo dal ciclo notturno: toglilo dal frontmatter.`;
  if (typeof fm.path === "string" && fm.path.replace(/^\.?\//, "").startsWith("_inbox/")) return "La cartella _inbox/ è scritta solo dal ciclo notturno: scegli un altro percorso.";
  return null;
}

/** Highest classification the cloud agent can ever read through MCP (plan §3.6: pubblico, interno). */
const AGENT_MAX_CLASSIFICATION = 1;

const wantsPersonal = (markdown: string) => classificationLevel(parseDocument(markdown).frontmatter.classification, -1) === PERSONAL;
const notOwner = () => new AuthError("forbidden", "Solo il proprietario del vault personale può usare la classificazione «personale».");

/**
 * A corrected generated page keeps the marks of the dream cycle (subject, provenance) and its
 * path: an administrator corrects the text, not what the page is.
 */
function keepGeneratedMarks(cur: { frontmatter: Record<string, unknown>; path: string }, markdown: string): string {
  const doc = parseDocument(markdown);
  const fm: Record<string, unknown> = { ...doc.frontmatter, path: cur.path };
  for (const k of ["hive_subject", "promoted_from"]) {
    if (k in cur.frontmatter) fm[k] = cur.frontmatter[k];
    else delete fm[k];
  }
  return serializeDocument(fm, doc.body);
}

export function workspaceRoutes(app: FastifyInstance, sql: Sql, auth: AuthService): void {
  const pages = new PageStore(sql);
  const reader = (req: FastifyRequest, only?: string[]) => {
    const a = requireAuth(req);
    if (a.principal.kind === "api" && !a.principal.scopes.includes("read")) throw new AuthError("forbidden", "Questo account API non ha l'ambito di lettura.");
    return { a, p: Access.toReader(a.ctx, only) };
  };

  /** True when at least one active API account can read this page through MCP. */
  async function agentReadable(vaultId: string, classification: number): Promise<boolean> {
    if (classification > AGENT_MAX_CLASSIFICATION) return false;
    const [r] = await sql<{ ok: boolean }[]>`
      select exists(
        select 1 from principals pr join vault_grants g on g.principal_id = pr.id
        where pr.kind = 'api' and pr.status = 'active' and (pr.expires_at is null or pr.expires_at > now())
          and pr.scopes && array['read', 'write', 'ingest']::text[] and pr.clearance >= ${classification} and g.vault_id = ${vaultId}
      ) as ok`;
    return !!r?.ok;
  }

  // ---------------------------------------------------------------------------
  // Tree
  // ---------------------------------------------------------------------------
  app.get<{ Params: { vaultId: string } }>("/api/vaults/:vaultId/folders", async (req) => {
    requireAction(req, "vault.read", req.params.vaultId);
    const { p } = reader(req, [req.params.vaultId]);
    return folderCounts(sql, p, req.params.vaultId);
  });

  app.get<{ Params: { vaultId: string }; Querystring: { folder: string; cursor?: string; limit?: number } }>(
    "/api/vaults/:vaultId/pages",
    { schema: { querystring: { type: "object", required: ["folder"], properties: { folder: str(40), cursor: str(600), limit: int(1, 500) } } } },
    async (req) => {
      requireAction(req, "vault.read", req.params.vaultId);
      const { p } = reader(req, [req.params.vaultId]);
      return listPages(sql, p, req.params.vaultId, req.query.folder, { ...(req.query.cursor ? { cursor: req.query.cursor } : {}), ...(req.query.limit ? { limit: req.query.limit } : {}) });
    },
  );

  app.get<{ Querystring: { limit?: number } }>("/api/recent", { schema: { querystring: { type: "object", properties: { limit: int(1, 200) } } } }, async (req) => {
    const { p } = reader(req);
    return recentPages(sql, p, req.query.limit ?? 30);
  });

  app.get<{ Querystring: { q?: string; vault?: string; limit?: number } }>(
    "/api/suggest",
    { schema: { querystring: { type: "object", properties: { q: { type: "string", maxLength: 200 }, vault: str(64), limit: int(1, 50) } } } },
    async (req) => {
      const { p } = reader(req);
      return suggest(sql, p, req.query.q ?? "", { ...(req.query.vault ? { vaultId: req.query.vault } : {}), ...(req.query.limit ? { limit: req.query.limit } : {}) });
    },
  );

  app.get<{ Querystring: { vault?: string; limit?: number } }>(
    "/api/tags",
    { schema: { querystring: { type: "object", properties: { vault: str(64), limit: int(1, 1000) } } } },
    async (req) => {
      const { p } = reader(req);
      return tagCounts(sql, p, { ...(req.query.vault ? { vaultId: req.query.vault } : {}), ...(req.query.limit ? { limit: req.query.limit } : {}) });
    },
  );

  app.get<{ Querystring: { vaults?: string; folders?: string; limit?: number; offset?: number } }>(
    "/api/graph",
    { schema: { querystring: { type: "object", properties: { vaults: str(4000), folders: str(200), limit: int(1, 2000), offset: int(0, 1_000_000) } } } },
    async (req) => {
      const { p } = reader(req);
      const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
      return graph(sql, p, {
        ...(list(req.query.vaults) ? { vaults: list(req.query.vaults)! } : {}),
        ...(list(req.query.folders) ? { folders: list(req.query.folders)! } : {}),
        ...(req.query.limit ? { limit: req.query.limit } : {}),
        ...(req.query.offset ? { offset: req.query.offset } : {}),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/pages/:id/full", async (req) => {
    const { a, p } = reader(req);
    const page = await fullPage(sql, p, req.params.id);
    if (!page) throw new AuthError("not_found", "Pagina non trovata.");
    auth.audit.write({ principalId: a.principal.id, action: "page.read", resource: page.id, ...meta(req), data: { classification: page.classification, tokens: page.tokens, via: a.via, full: true } });
    return {
      ...page,
      permission: a.ctx.vaults.get(page.vaultId) ?? null,
      canWrite: Access.can(a.ctx, "vault.write", page.vaultId) && (!generated(page) || a.ctx.isAdmin),
      generated: generated(page),
      // administrators correct a generated page at once (rectification): the sources follow
      rectifiable: generated(page) && a.ctx.isAdmin && a.principal.kind === "user",
      personalOwner: Access.ownsPersonal(a.ctx, page.vaultId),
      agentReadable: await agentReadable(page.vaultId, page.classification),
    };
  });

  app.get<{ Params: { id: string } }>("/api/pages/:id/backlinks", async (req) => {
    const { p } = reader(req);
    return backlinks(sql, p, req.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/pages/:id/versions", async (req) => {
    const { p } = reader(req);
    const v = await versions(sql, p, req.params.id);
    if (!v) throw new AuthError("not_found", "Pagina non trovata.");
    return v;
  });

  app.get<{ Params: { id: string; v: number } }>(
    "/api/pages/:id/versions/:v",
    { schema: { params: { type: "object", properties: { id: str(64), v: int(1, 1_000_000) } } } },
    async (req) => {
      const { p } = reader(req);
      const v = await version(sql, p, req.params.id, req.params.v);
      if (!v) throw new AuthError("not_found", "Versione non trovata.");
      return v;
    },
  );

  app.post<{ Params: { vaultId: string }; Body: { title: string; type?: string; body?: string; classification?: number } }>(
    "/api/vaults/:vaultId/pages",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          properties: { title: str(300), type: str(64), body: { type: "string", maxLength: 2_000_000 }, classification: int(0, PERSONAL) },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const a = requireAction(req, "vault.write", req.params.vaultId);
      if (req.body.classification === PERSONAL && !Access.ownsPersonal(a.ctx, req.params.vaultId)) throw notOwner();
      const fm: Record<string, unknown> = { title: req.body.title.trim(), type: req.body.type ?? "note", author: a.principal.name };
      if (req.body.classification !== undefined) fm.classification = req.body.classification;
      const exists = await PageStore.resolve(sql, [req.params.vaultId], fm.title as string);
      if (exists.length) throw new AuthError("conflict", `Esiste già una pagina "${exists[0]!.title}" in questo vault.`);
      const r = await pages.upsert({ vaultId: req.params.vaultId, frontmatter: fm, body: req.body.body ?? `# ${fm.title}\n\n`, author: a.principal.id });
      await auth.audit.writeNow({ principalId: a.principal.id, action: "page.create", resource: r.page.id, ...meta(req), data: { vault: req.params.vaultId, classification: r.page.classification } });
      return reply.status(201).send({ id: r.page.id, version: r.page.version, path: r.page.path });
    },
  );

  /** Editor save. `baseVersion` is the version the editor started from: another save in between → 409. */
  app.put<{ Params: { id: string }; Body: { markdown: string; baseVersion: number } }>(
    "/api/pages/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["markdown", "baseVersion"],
          properties: { markdown: { type: "string", maxLength: 2_000_000 }, baseVersion: int(1, 1_000_000) },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { a, p } = reader(req);
      const [cur] = await withReader(sql, p, (tx) => tx<{ vaultId: string; version: number; classification: number; frontmatter: Record<string, unknown>; path: string; title: string; body: string }[]>`
        select vault_id as "vaultId", version, classification, frontmatter, path, title, body from pages where id = ${req.params.id}`);
      if (!cur) throw new AuthError("not_found", "Pagina non trovata.");
      requireAction(req, "vault.write", cur.vaultId);
      const gen = generated(cur);
      if (gen && !(a.ctx.isAdmin && a.principal.kind === "user")) {
        throw new AuthError("conflict", "Questa pagina è scritta dal ciclo notturno: modifica le pagine delle celle o decidi nella coda dei curatori. Un amministratore può rettificarla subito.");
      }
      let markdown = req.body.markdown;
      if (gen) markdown = keepGeneratedMarks(cur, markdown);
      else {
        const reserved = reservedMarks(markdown);
        if (reserved) throw new AuthError("invalid_request", reserved);
      }
      if (wantsPersonal(markdown) && !Access.ownsPersonal(a.ctx, cur.vaultId)) throw notOwner();
      if (cur.version !== req.body.baseVersion) {
        throw new AuthError("conflict", `La pagina è stata modificata (versione ${cur.version}) mentre la stavi scrivendo.`);
      }
      const r = await pages.upsert({ vaultId: cur.vaultId, id: req.params.id, markdown, author: a.principal.id });
      let rectification: { itemId: string } & RectificationTargets | undefined;
      if (r.changed && gen) {
        // the wrong data comes from the cited pages and documents: they must be corrected too
        const targets = await rectificationTargets(sql, [cur.body, r.page.body]);
        const itemId = await openRectification(sql, { id: r.page.id, vaultId: cur.vaultId, title: r.page.title, frontmatter: cur.frontmatter }, a.principal.id, targets);
        rectification = { itemId, ...targets };
      }
      if (r.changed) {
        await auth.audit.writeNow({
          principalId: a.principal.id,
          action: gen ? "page.rectify" : "page.update",
          resource: r.page.id,
          ...meta(req),
          data: {
            version: r.page.version,
            classification: r.page.classification,
            ...(r.page.classification !== cur.classification ? { classificationFrom: cur.classification } : {}),
            ...(rectification ? { curatorItem: rectification.itemId, pages: rectification.pages.length, sources: rectification.sources.length } : {}),
          },
        });
      }
      return { id: r.page.id, version: r.page.version, changed: r.changed, path: r.page.path, title: r.page.title, ...(rectification ? { rectification } : {}) };
    },
  );

  /** Restores an old version: it becomes a new version on top (history is never rewritten). */
  app.post<{ Params: { id: string }; Body: { version: number } }>(
    "/api/pages/:id/restore",
    { schema: { body: { type: "object", required: ["version"], properties: { version: int(1, 1_000_000) }, additionalProperties: false } } },
    async (req) => {
      const { a, p } = reader(req);
      const [cur] = await withReader(sql, p, (tx) => tx<{ vaultId: string; version: number; frontmatter: Record<string, unknown>; path: string }[]>`
        select vault_id as "vaultId", version, frontmatter, path from pages where id = ${req.params.id}`);
      if (!cur) throw new AuthError("not_found", "Pagina non trovata.");
      requireAction(req, "vault.write", cur.vaultId);
      if (generated(cur)) throw new AuthError("conflict", "Questa pagina è scritta dal ciclo notturno e non si ripristina.");
      if (req.body.version === cur.version) throw new AuthError("conflict", "È già la versione attuale.");
      const old = await version(sql, p, req.params.id, req.body.version);
      if (!old) throw new AuthError("not_found", "Versione non trovata.");
      const markdown = serializeDocument({ ...old.frontmatter, id: req.params.id, title: old.title }, old.body);
      const r = await pages.upsert({ vaultId: cur.vaultId, id: req.params.id, markdown, author: a.principal.id });
      await auth.audit.writeNow({ principalId: a.principal.id, action: "page.restore", resource: r.page.id, ...meta(req), data: { from: req.body.version, version: r.page.version } });
      return { id: r.page.id, version: r.page.version, changed: r.changed };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/pages/:id", async (req) => {
    const { a, p } = reader(req);
    const [cur] = await withReader(sql, p, (tx) => tx<{ vaultId: string; frontmatter: Record<string, unknown>; path: string }[]>`
      select vault_id as "vaultId", frontmatter, path from pages where id = ${req.params.id}`);
    if (!cur) throw new AuthError("not_found", "Pagina non trovata.");
    requireAction(req, "vault.write", cur.vaultId);
    if (generated(cur)) throw new AuthError("conflict", "Questa pagina è scritta dal ciclo notturno e torna alla notte successiva.");
    await pages.delete(req.params.id);
    await auth.audit.writeNow({ principalId: a.principal.id, action: "page.delete", resource: req.params.id, ...meta(req), data: { vault: cur.vaultId } });
    return { ok: true };
  });

  /** Markdown file of the page (frontmatter + body), as the Obsidian export writes it. */
  app.get<{ Params: { id: string } }>("/api/pages/:id/markdown", async (req, reply) => {
    const { p } = reader(req);
    const page = await fullPage(sql, p, req.params.id);
    if (!page) throw new AuthError("not_found", "Pagina non trovata.");
    reply.header("content-type", "text/markdown; charset=utf-8");
    return serializeDocument({ ...page.frontmatter, id: page.id, title: page.title, type: page.type }, page.body);
  });

  // ---------------------------------------------------------------------------
  // Sources: text, inbox, review
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { offset?: number; limit?: number } }>(
    "/api/sources/:id/chunks",
    { schema: { querystring: { type: "object", properties: { offset: int(0, 10_000_000), limit: int(1, 1000) } } } },
    async (req) => {
      const { p } = reader(req);
      return sourceChunks(sql, p, req.params.id, { ...(req.query.offset ? { offset: req.query.offset } : {}), ...(req.query.limit ? { limit: req.query.limit } : {}) });
    },
  );

  const SOURCE_COLS = sql.unsafe(`id, vault_id as "vaultId", name, mime, size, status, level, origin, title, classification,
    compiled_page as "compiledPage", text_tokens as "textTokens", error, meta->'warnings' as warnings,
    created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"`);

  /** Latest sources of the readable vaults, the caller's own first. */
  app.get<{ Querystring: { limit?: number; mine?: boolean } }>(
    "/api/inbox",
    { schema: { querystring: { type: "object", properties: { limit: int(1, 500), mine: { type: "boolean" } } } } },
    async (req) => {
      const { a, p } = reader(req);
      return withReader(sql, p, (tx) => tx`
        select ${SOURCE_COLS} from sources
        where vault_id = any(${p.vaults}) and parent_id is null
          and (${req.query.mine ?? false} = false or created_by = ${a.principal.id})
        order by created_at desc limit ${req.query.limit ?? 100}`);
    },
  );

  /** "Da rivedere": sources that failed, are not supported or need OCR. */
  app.get<{ Querystring: { limit?: number } }>("/api/review", { schema: { querystring: { type: "object", properties: { limit: int(1, 500) } } } }, async (req) => {
    const { p } = reader(req);
    return withReader(sql, p, (tx) => tx`
      select ${SOURCE_COLS} from sources
      where vault_id = any(${p.vaults})
        and (status in ('failed', 'unsupported') or meta->'warnings' ?| array['needs_ocr', 'ocr_unavailable', 'ocr_failed', 'little_text'])
        and not (meta ? 'reviewed')
      order by updated_at desc limit ${req.query.limit ?? 200}`);
  });

  // ---------------------------------------------------------------------------
  // Notice about the cloud agent (D1) and "Cosa ha letto l'agente cloud"
  // ---------------------------------------------------------------------------
  app.get("/api/me/notice", async (req) => {
    const a = requireUser(req);
    const [r] = await sql<{ at: Date | null }[]>`select notice_ack_at as at from principals where id = ${a.principal.id}`;
    return { acknowledgedAt: r?.at ?? null };
  });

  app.post("/api/me/notice", async (req) => {
    const a = requireUser(req);
    const [r] = await sql<{ at: Date }[]>`
      update principals set notice_ack_at = coalesce(notice_ack_at, now()) where id = ${a.principal.id} returning notice_ack_at as at`;
    await auth.audit.writeNow({ principalId: a.principal.id, action: "me.notice.ack", resource: "cloud-agent", ...meta(req) });
    return { acknowledgedAt: r!.at };
  });

  /** Reads by API accounts (the cloud agent) of pages in the caller's own cell vaults, last 30 days. */
  app.get<{ Querystring: { days?: number } }>("/api/me/agent-reads", { schema: { querystring: { type: "object", properties: { days: int(1, 365) } } } }, async (req) => {
    const a = requireUser(req);
    const own = await sql<{ id: string }[]>`select id from vaults where owner = ${`user:${a.principal.id}`}`;
    if (!own.length) return { vaults: [], reads: [] };
    const reads = await sql`
      select l.at, l.action, l.resource as "pageId", pg.title, pr.name as account, pr.display_name as "accountName",
             (l.data->>'tokens')::int as tokens, (l.data->>'classification')::int as classification
      from audit_log l
      join principals pr on pr.id = l.principal_id and pr.kind = 'api'
      join pages pg on pg.id = l.resource
      where l.at > now() - make_interval(days => ${req.query.days ?? 30}) and l.action = 'page.read'
        and pg.vault_id = any(${own.map((v) => v.id)})
      order by l.at desc limit 500`;
    return { vaults: own.map((v) => v.id), reads };
  });
}
