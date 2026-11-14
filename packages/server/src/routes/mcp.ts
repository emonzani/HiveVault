/**
 * MCP endpoint (plan §7.1): streamable HTTP, stateless (one server object per request, so any
 * server process answers any request). Only API accounts with a Bearer key: the account's
 * grants, scopes and clearance decide what the cloud agent sees, capped at "interno".
 */
import type { FastifyInstance } from "fastify";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthError, type AuthService } from "@cb/auth";
import type { PageStore, SearchEngine } from "@cb/brain";
import type { Sql } from "@cb/db";
import { createMcpServer, type SourceSink } from "@cb/mcp";
import type { ModelDispatcher } from "@cb/models";
import { meta, requireAuth } from "../http.ts";

const HOP = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "content-encoding"]);

export interface McpDeps {
  sql: Sql;
  auth: AuthService;
  search: SearchEngine;
  pages: PageStore;
  dispatcher?: ModelDispatcher;
  /** Ingestion: brain_capture with compile sends the note through I1–I3 as a source. */
  ingest?: SourceSink;
}

export function mcpRoutes(app: FastifyInstance, d: McpDeps): void {
  app.post("/mcp", async (req, reply) => {
    const a = requireAuth(req);
    if (a.via !== "apikey" || a.principal.kind !== "api") throw new AuthError("forbidden", "Il server MCP accetta solo account API con chiave (Authorization: Bearer).");
    if (!a.principal.scopes.includes("read")) throw new AuthError("forbidden", "Questo account API non ha l'ambito di lettura.");
    const server = createMcpServer({
      sql: d.sql,
      search: d.search,
      pages: d.pages,
      ...(d.dispatcher ? { dispatcher: d.dispatcher } : {}),
      ...(d.ingest ? { ingest: d.ingest } : {}),
      audit: d.auth.audit,
      // the clearance of the context: a key bound to a user never reads above that user
      account: { id: a.principal.id, name: a.principal.name, scopes: a.principal.scopes, clearance: a.ctx.clearance },
      vaults: new Map([...a.ctx.vaults.entries()]),
      meta: meta(req),
    });
    // Web-standard transport with JSON answers: the response goes back through Fastify (security
    // headers, compression, logging) like every other route.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !HOP.has(k)) headers.set(k, v);
      const res = await transport.handleRequest(new Request(`http://localhost${req.url}`, { method: "POST", headers }), { parsedBody: req.body });
      reply.status(res.status).header("cache-control", "no-store");
      // hop-by-hop headers of the SDK response belong to Fastify's own response
      res.headers.forEach((v, k) => {
        if (!HOP.has(k)) reply.header(k, v);
      });
      return reply.send(res.body ? await res.text() : "");
    } finally {
      await transport.close();
      await server.close();
    }
  });

  // stateless server: no server-initiated stream, no session to delete
  const notAllowed = { error: { code: "method_not_allowed", message: "Usa POST /mcp (streamable HTTP senza sessione)." } };
  app.get("/mcp", async (_req, reply) => reply.status(405).header("allow", "POST").send(notAllowed));
  app.delete("/mcp", async (_req, reply) => reply.status(405).header("allow", "POST").send(notAllowed));
}
