/**
 * Read API of the memory for users and API accounts. The vault list and the clearance
 * come from the access context (Access.toReader); the engine runs them through RLS.
 * Every read by an API account is audited (plan §3.6: "Cosa ha letto l'agente cloud").
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Access, AuthError, type AuthService } from "@cb/auth";
import { neighbors, readPage, type SearchEngine } from "@cb/brain";
import type { Sql } from "@cb/db";
import type { IngestService } from "@cb/ingest";
import { meta, requireAuth } from "../http.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;

export function brainRoutes(app: FastifyInstance, sql: Sql, auth: AuthService, search: SearchEngine, ingest?: IngestService): void {
  const readerOf = (req: FastifyRequest, only?: string[]) => {
    const a = requireAuth(req);
    if (a.principal.kind === "api" && !a.principal.scopes.includes("read")) throw new AuthError("forbidden", "Questo account API non ha l'ambito di lettura.");
    return { a, reader: Access.toReader(a.ctx, only) };
  };

  app.get("/api/vaults", async (req) => {
    const { a } = readerOf(req);
    const rows = await sql<{ id: string; slug: string; name: string; kind: string; version: number; defaultClassification: number }[]>`
      select id, slug, name, kind, version, default_classification as "defaultClassification" from vaults where id = any(${[...a.ctx.vaults.keys()]}) order by kind, name`;
    // personal: the caller's own personal vault, the only place it may use "personale"
    return rows.map((v) => ({ ...v, permission: a.ctx.vaults.get(v.id), personal: a.ctx.personal.includes(v.id) }));
  });

  app.post<{ Body: { query: string; vaults?: string[]; types?: string[]; limit?: number; maxTokens?: number; rerank?: boolean } }>(
    "/api/search",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: str(1000),
            vaults: { type: "array", maxItems: 200, items: str(64) },
            types: { type: "array", maxItems: 20, items: str(64) },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            maxTokens: { type: "integer", minimum: 100, maximum: 50000 },
            rerank: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { a, reader } = readerOf(req, req.body.vaults);
      const { vaults: _v, query, ...opts } = req.body;
      const r = await search.search(reader, query, opts);
      // compile on demand: hits on sources that are not compiled yet
      if (ingest && !r.cached) void ingest.onSearchHits(r.hits).catch(() => {});
      if (a.via === "apikey") {
        auth.audit.write({
          principalId: a.principal.id,
          action: "search",
          resource: null,
          ...meta(req),
          data: { query: query.slice(0, 200), hits: r.hits.map((h) => ({ id: h.id, classification: h.classification })) },
        });
      }
      return r;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { maxTokens?: number; sections?: string; query?: string } }>(
    "/api/pages/:id",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { maxTokens: { type: "integer", minimum: 50, maximum: 50000 }, sections: str(500), query: str(1000) },
        },
      },
    },
    async (req) => {
      const { a, reader } = readerOf(req);
      const r = await readPage(sql, reader, req.params.id, {
        ...(req.query.maxTokens ? { maxTokens: req.query.maxTokens } : {}),
        ...(req.query.sections ? { sections: req.query.sections.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(req.query.query ? { query: req.query.query } : {}),
      });
      if (!r) throw new AuthError("not_found", "Pagina non trovata.");
      auth.audit.write({
        principalId: a.principal.id,
        action: "page.read",
        resource: r.id,
        ...meta(req),
        data: { classification: r.classification, tokens: r.contentTokens, via: a.via },
      });
      return r;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { depth?: number } }>(
    "/api/pages/:id/neighbors",
    { schema: { querystring: { type: "object", properties: { depth: { type: "integer", minimum: 1, maximum: 3 } } } } },
    async (req) => {
      const { reader } = readerOf(req);
      return neighbors(sql, reader, req.params.id, req.query.depth ?? 1);
    },
  );
}
