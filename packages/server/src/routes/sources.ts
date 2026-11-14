/**
 * Sources: upload (streaming multipart), links, list and status, original file, reingest,
 * compile now, and server-sent events for status changes.
 */
import type { FastifyInstance } from "fastify";
import { Access, AuthError, type AuthService } from "@cb/auth";
import { PERSONAL, withReader } from "@cb/brain";
import type { Sql } from "@cb/db";
import { LinkError, SourceError, type IngestService } from "@cb/ingest";
import { meta, requireAction, requireAuth } from "../http.ts";

const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/(plain|csv|markdown))$/;
const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;
const notOwner = () => new AuthError("forbidden", "Solo il proprietario del vault personale può usare la classificazione «personale».");

export function sourceRoutes(app: FastifyInstance, sql: Sql, auth: AuthService, ingest: IngestService, o: { uploadMaxBytes: number }): void {
  /** A source the caller may read (RLS: vault and clearance), or 404. */
  async function readable(req: Parameters<typeof requireAuth>[0], id: string) {
    const a = requireAuth(req);
    const [s] = await withReader(sql, Access.toReader(a.ctx), (tx) => tx<{ id: string; vault_id: string }[]>`select id, vault_id from sources where id = ${id}`);
    if (!s) throw new AuthError("not_found", "Sorgente non trovata.");
    return { a, vaultId: s.vault_id };
  }

  app.post<{ Params: { vaultId: string } }>("/api/vaults/:vaultId/sources", async (req, reply) => {
    const a = requireAction(req, "vault.write", req.params.vaultId);
    if (a.principal.kind === "api" && !a.principal.scopes.some((s) => s === "ingest" || s === "write")) throw new AuthError("forbidden", "Serve l'ambito ingest.");
    if (!req.isMultipart()) throw new AuthError("invalid_request", "Invia i file come multipart/form-data.");
    const results: unknown[] = [];
    let compile: boolean | undefined;
    let classification: number | undefined;
    for await (const part of req.parts({ limits: { fileSize: o.uploadMaxBytes, files: 50 } })) {
      if (part.type === "field") {
        if (part.fieldname === "compile") compile = String(part.value) === "true";
        if (part.fieldname === "classification" && /^[0-4]$/.test(String(part.value))) classification = Number(part.value);
        if (classification === PERSONAL && !Access.ownsPersonal(a.ctx, req.params.vaultId)) throw notOwner();
        continue;
      }
      const r = await ingest.upload(req.params.vaultId, part.file, part.filename || "senza-nome", a.principal.id, {
        ...(compile !== undefined ? { compile } : {}),
        ...(classification !== undefined ? { classification } : {}),
      });
      if (part.file.truncated) {
        await sql`update sources set status = 'failed', error = 'file oltre il limite di dimensione' where id = ${r.source.id}`;
        throw new AuthError("invalid_request", `"${part.filename}" supera il limite di ${Math.round(o.uploadMaxBytes / 1024 ** 2)} MB.`);
      }
      results.push({ id: r.source.id, name: r.source.name, size: r.source.size, created: r.created, status: r.source.status, taskId: r.taskId });
      auth.audit.write({ principalId: a.principal.id, action: "source.upload", resource: r.source.id, ...meta(req), data: { vault: req.params.vaultId, name: r.source.name, size: r.source.size, created: r.created } });
    }
    if (!results.length) throw new AuthError("invalid_request", "Nessun file ricevuto.");
    return reply.status(202).send({ sources: results });
  });

  app.post<{ Params: { vaultId: string }; Body: { url: string; compile?: boolean; classification?: number } }>(
    "/api/vaults/:vaultId/links",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: { url: str(2000), compile: { type: "boolean" }, classification: { type: "integer", minimum: 0, maximum: PERSONAL } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const a = requireAction(req, "vault.write", req.params.vaultId);
      if (req.body.classification === PERSONAL && !Access.ownsPersonal(a.ctx, req.params.vaultId)) throw notOwner();
      try {
        const { url, ...opts } = req.body;
        const r = await ingest.link(req.params.vaultId, url, a.principal.id, opts);
        await auth.audit.writeNow({ principalId: a.principal.id, action: "source.link", resource: r.source.id, ...meta(req), data: { url: r.source.path } });
        return reply.status(202).send({ id: r.source.id, created: r.created, status: r.source.status, url: r.source.path });
      } catch (e) {
        if (e instanceof LinkError) throw new AuthError("invalid_request", e.message);
        if ((e as { code?: string }).code === "EGRESS_BLOCKED") throw new AuthError("forbidden", "Connessione verso quel sito non consentita.");
        throw e;
      }
    },
  );

  app.get<{ Params: { vaultId: string }; Querystring: { status?: string; limit?: number; before?: string } }>(
    "/api/vaults/:vaultId/sources",
    { schema: { querystring: { type: "object", properties: { status: str(20), limit: { type: "integer", minimum: 1, maximum: 500 }, before: { type: "string", format: "date-time" } } } } },
    async (req) => {
      const a = requireAction(req, "vault.read", req.params.vaultId);
      return withReader(sql, Access.toReader(a.ctx, [req.params.vaultId]), (tx) => tx`
        select id, name, mime, size, status, level, origin, path, parent_id as "parentId", title, classification, compile,
               compiled_page as "compiledPage", text_tokens as "textTokens", error, created_at as "createdAt", updated_at as "updatedAt",
               meta->'warnings' as warnings
        from sources
        where vault_id = ${req.params.vaultId}
          and (${req.query.status ?? null}::text is null or status = ${req.query.status ?? null})
          and (${req.query.before ?? null}::timestamptz is null or created_at < ${req.query.before ?? null}::timestamptz)
        order by created_at desc limit ${req.query.limit ?? 100}`);
    },
  );

  /**
   * M14: the compilation queue of the installation and the estimated wait (counts only), for the
   * upload dialog and the inbox.
   */
  app.get("/api/sources/queue", async (req) => {
    requireAuth(req);
    return ingest.compileQueue();
  });

  /**
   * Documents still in the pipeline, in the vaults the caller reads (RLS): the tabs, the inbox
   * and the source view mark them. A source keeps its level (e.g. I2) while its compile waits.
   */
  app.get("/api/sources/working", async (req) => {
    const a = requireAuth(req);
    const reader = Access.toReader(a.ctx);
    if (!reader.vaults.length) return [];
    const ids = await withReader(sql, reader, (tx) => tx<{ id: string; taskId: string }[]>`
      select id, task_id as "taskId" from sources where vault_id = any(${reader.vaults}) and task_id is not null and status not in ('failed', 'unsupported')
        and (level < 3 or status <> 'compiled') order by updated_at desc limit 2000`);
    if (!ids.length) return [];
    // tasks are not under RLS: read only those of the sources found above
    const live = await sql<{ id: string; status: string; phase: string; runAfter: Date }[]>`
      select id, status, phase, run_after as "runAfter" from tasks where id = any(${ids.map((r) => r.taskId)}) and status in ('queued', 'running', 'sleeping', 'waiting')`;
    const byTask = new Map(live.map((t) => [t.id, t]));
    return ids.flatMap((r) => {
      const t = byTask.get(r.taskId);
      return t ? [{ id: r.id, phase: t.phase, task: t.status, waitingModel: (t.phase === "compile" || t.phase === "ocr") && t.status === "sleeping" }] : [];
    }).slice(0, 500);
  });

  app.get<{ Params: { id: string } }>("/api/sources/:id", async (req) => {
    const { a } = await readable(req, req.params.id);
    const [s] = await withReader(sql, Access.toReader(a.ctx), (tx) => tx`
      select s.id, s.vault_id as "vaultId", s.name, s.mime, s.size, s.status, s.level, s.origin, s.path, s.parent_id as "parentId",
             s.title, s.classification, s.compile, s.compiled_page as "compiledPage", s.text_tokens as "textTokens", s.error,
             s.parser_version as "parserVersion", s.meta, s.created_by as "createdBy", s.created_at as "createdAt", s.updated_at as "updatedAt",
             (select count(*)::int from chunks c where c.vault_id = s.vault_id and c.source_id = s.id) as chunks,
             (select json_agg(json_build_object('id', k.id, 'name', k.name, 'status', k.status, 'level', k.level)) from sources k where k.parent_id = s.id) as children
      from sources s where s.id = ${req.params.id}`);
    const [t] = await sql<{ status: string; phase: string; attempts: number; error: string | null }[]>`
      select t.status, t.phase, t.attempts, t.error from tasks t join sources s on s.task_id = t.id where s.id = ${req.params.id}`;
    return { ...s, task: t ?? null };
  });

  /** The original file, decrypted. People only: API accounts (the cloud agent) never receive originals. */
  app.get<{ Params: { id: string }; Querystring: { inline?: boolean } }>("/api/sources/:id/original", { schema: { querystring: { type: "object", properties: { inline: { type: "boolean" } } } } }, async (req, reply) => {
    const { a } = await readable(req, req.params.id);
    if (a.principal.kind === "api") throw new AuthError("forbidden", "I documenti originali non sono disponibili agli account API.");
    const [s] = await sql<{ vault_id: string; sha256: string; name: string; mime: string; size: number }[]>`select vault_id, sha256, name, mime, size from sources where id = ${req.params.id}`;
    auth.audit.write({ principalId: a.principal.id, action: "source.download", resource: req.params.id, ...meta(req) });
    reply.header("content-type", s!.mime);
    reply.header("content-length", String(s!.size));
    // Inline view in the source panel only for types the browser shows without running page
    // code (PDF viewer, raster images, plain text); everything else is a download.
    const inline = req.query.inline === true && INLINE_TYPES.test(s!.mime);
    reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(s!.name)}`);
    if (inline) {
      reply.header("x-frame-options", "SAMEORIGIN");
      reply.header("content-security-policy", s!.mime === "application/pdf" ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'self'");
      if (s!.mime.startsWith("text/")) reply.header("content-type", "text/plain; charset=utf-8");
    }
    reply.header("cache-control", "private, no-store");
    return reply.send(await ingest.store.blobs.get(s!.vault_id, s!.sha256));
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/reingest", async (req) => {
    const { vaultId } = await readable(req, req.params.id);
    const a = requireAction(req, "vault.write", vaultId);
    const taskId = await ingest.reingest(req.params.id);
    await auth.audit.writeNow({ principalId: a.principal.id, action: "source.reingest", resource: req.params.id, ...meta(req) });
    return { taskId };
  });

  /** Deleting or replacing a source: its uploader with write permission, otherwise a curator. */
  async function owned(req: Parameters<typeof requireAuth>[0], id: string) {
    const { vaultId } = await readable(req, id);
    const [s] = await sql<{ by: string | null }[]>`select created_by as by from sources where id = ${id}`;
    const a = requireAuth(req);
    return { a: requireAction(req, s?.by === a.principal.id ? "vault.write" : "vault.curate", vaultId), vaultId };
  }
  const sourceError = (e: unknown): never => {
    if (e instanceof SourceError) throw new AuthError(e.code === "not_link" ? "invalid_request" : "conflict", e.message);
    if (e instanceof LinkError) throw new AuthError("invalid_request", e.message);
    if ((e as { code?: string }).code === "EGRESS_BLOCKED") throw new AuthError("forbidden", "Connessione verso quel sito non consentita.");
    throw e;
  };

  /** "Da rivedere": the source is fine as it is. */
  app.post<{ Params: { id: string } }>("/api/sources/:id/reviewed", async (req) => {
    const { vaultId } = await readable(req, req.params.id);
    const a = requireAction(req, "vault.write", vaultId);
    await ingest.markReviewed(req.params.id, a.principal.id);
    await auth.audit.writeNow({ principalId: a.principal.id, action: "source.reviewed", resource: req.params.id, ...meta(req) });
    return { ok: true };
  });

  /** A link that gave the wrong content: fetch another URL in its place. */
  app.post<{ Params: { id: string }; Body: { url: string } }>(
    "/api/sources/:id/relink",
    { schema: { body: { type: "object", required: ["url"], properties: { url: str(2000) }, additionalProperties: false } } },
    async (req) => {
      const { a } = await owned(req, req.params.id);
      const r = await ingest.relink(req.params.id, req.body.url, a.principal.id).catch(sourceError);
      await auth.audit.writeNow({ principalId: a.principal.id, action: "source.relink", resource: req.params.id, ...meta(req), data: { url: r.source.path, replacedBy: r.source.id } });
      return { id: r.source.id, created: r.created, status: r.source.status, url: r.source.path };
    },
  );

  /** Deletes the source, its members, chunks, compiled pages and original files. */
  app.delete<{ Params: { id: string } }>("/api/sources/:id", async (req) => {
    const { a, vaultId } = await owned(req, req.params.id);
    const r = await ingest.remove(req.params.id).catch(sourceError);
    await auth.audit.writeNow({ principalId: a.principal.id, action: "source.delete", resource: req.params.id, ...meta(req), data: { vault: vaultId, ...r } });
    return r;
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/compile", async (req) => {
    const { vaultId } = await readable(req, req.params.id);
    const a = requireAction(req, "vault.write", vaultId);
    const taskId = await ingest.compileNow(req.params.id, 1);
    await auth.audit.writeNow({ principalId: a.principal.id, action: "source.compile", resource: req.params.id, ...meta(req) });
    return { taskId };
  });

  /** Server-sent events: status changes of the sources in the caller's vaults. */
  app.get("/api/events", async (req, reply) => {
    const a = requireAuth(req);
    const vaults = new Set(a.ctx.vaults.keys());
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write(`retry: 3000\n\n`);
    const listener = await sql.listen("cb_source", (payload) => {
      try {
        const e = JSON.parse(payload) as { vault: string };
        if (vaults.has(e.vault)) reply.raw.write(`event: source\ndata: ${payload}\n\n`);
      } catch {
        /* ignore malformed notifications */
      }
    });
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      void listener.unlisten();
    });
  });
}
