import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AuthService } from "@cb/auth";
import type { SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import type { ImportService, IngestService } from "@cb/ingest";
import { readFileSync } from "node:fs";
import { installHttp } from "./http.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { brainRoutes } from "./routes/brain.ts";
import { hiveRoutes, type HiveDeps } from "./routes/hive.ts";
import { importRoutes } from "./routes/imports.ts";
import { mcpRoutes, type McpDeps } from "./routes/mcp.ts";
import { opsRoutes, type OpsDeps } from "./routes/ops.ts";
import { sourceRoutes } from "./routes/sources.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { projectRoutes } from "./routes/projects.ts";

const LLMS_TXT = (() => {
  try {
    return readFileSync(new URL("../../../docs/llms.txt", import.meta.url), "utf8");
  } catch {
    return "# HiveVault\n\n> MCP server at POST /mcp (Authorization: Bearer <API key>).\n";
  }
})();

export interface AppDeps {
  sql: Sql;
  auth: AuthService;
  vaults: VaultStore;
  search: SearchEngine;
  /** Optional: without it the source routes are not mounted (read-only server). */
  ingest?: IngestService;
  imports?: ImportService;
  /** Optional: curator queue, feeds, dream reports. */
  hive?: HiveDeps;
  /** Optional: MCP server for the cloud agent at /mcp. */
  mcp?: Omit<McpDeps, "sql" | "auth" | "search">;
  /** Optional: console operations (metrics, tasks, models, settings, backup). */
  ops?: Omit<OpsDeps, "sql" | "auth">;
  uploadMaxBytes?: number;
  secureCookies: boolean;
  rateLimitPerMin?: number;
  loginRateLimitPerMin?: number;
  /** Addresses (IP or CIDR) of the reverse proxies in front of the server (TRUST_PROXY); empty = no proxy. */
  trustProxy?: string[];
  logger?: boolean;
  https?: { cert: Buffer; key: Buffer } | null;
  /** Built web app (packages/web/dist): served at / with a fallback to index.html. */
  webDir?: string | null;
}

/** Builds the HTTP application. Tests use it with `app.inject`, without a socket. */
export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: d.logger ?? false,
    // only the listed proxies: req.ip is the rightmost X-Forwarded-For address that is not one of them
    trustProxy: d.trustProxy?.length ? d.trustProxy : false,
    bodyLimit: 2 * 1024 * 1024,
    ...(d.https ? { https: d.https } : {}),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", allErrors: false } },
  });
  await app.register(cookie);
  // brotli/gzip for the app files and the JSON answers (the event stream is hijacked: never buffered)
  await app.register(compress, { global: true, threshold: 1024, encodings: ["br", "gzip"] });
  await app.register(multipart);
  const spa = !!d.webDir && existsSync(path.join(d.webDir, "index.html"));
  installHttp(app, d.auth, {
    spa,
    rateLimitPerMin: d.rateLimitPerMin ?? 600,
    loginRateLimitPerMin: d.loginRateLimitPerMin ?? 20,
    secureCookies: d.secureCookies,
    hsts: !!d.https,
    ...(d.ops?.metricsToken ? { metricsToken: d.ops.metricsToken } : {}),
  });
  app.get("/api/health", async () => ({ status: "ok", time: new Date().toISOString() }));
  // map for agents (llms.txt format): how to connect and which MCP tools exist; no data
  app.get("/llms.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").header("cache-control", "public, max-age=3600").send(LLMS_TXT));
  authRoutes(app, d.auth, d.secureCookies);
  adminRoutes(app, d.auth, d.vaults, d.ops ? () => d.ops!.settings.get("defaults").classification : undefined, d.ingest);
  brainRoutes(app, d.sql, d.auth, d.search, d.ingest);
  workspaceRoutes(app, d.sql, d.auth);
  projectRoutes(app, d.sql, d.auth, d.vaults, d.ingest);
  if (d.hive) hiveRoutes(app, d.sql, d.auth, d.hive);
  if (d.mcp) mcpRoutes(app, { sql: d.sql, auth: d.auth, search: d.search, ...(d.ingest ? { ingest: d.ingest } : {}), ...d.mcp });
  if (d.ops) opsRoutes(app, { sql: d.sql, auth: d.auth, ...d.ops, ...(d.ingest ? { queue: () => d.ingest!.compileQueue() } : {}) });
  if (d.imports) importRoutes(app, d.auth, d.imports);
  if (d.ingest) sourceRoutes(app, d.sql, d.auth, d.ingest, { uploadMaxBytes: d.uploadMaxBytes ?? 500 * 1024 ** 2 });
  if (spa) {
    await app.register(fastifyStatic, {
      root: path.resolve(d.webDir!),
      wildcard: false,
      index: ["index.html"],
      // file names under assets/ carry a content hash: cached for a year; the rest is revalidated
      setHeaders: (res, file) => res.header("cache-control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache"),
    });
  }
  return app;
}
