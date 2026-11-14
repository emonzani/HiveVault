/**
 * Request-level plumbing: authentication, CSRF, rate limiting, security headers, errors.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Access, AuthError, type Action, type Authenticated, type AuthService } from "@cb/auth";
import { createLogger, metrics } from "@cb/shared";

export const SESSION_COOKIE = "cb_session";
export const CSRF_COOKIE = "cb_csrf";

/** Constant-time comparison of two secrets of any length. */
export const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
export const CSRF_HEADER = "x-cb-csrf";

declare module "fastify" {
  interface FastifyRequest {
    auth: Authenticated | null;
  }
}

const log = createLogger("http");

/** Fixed-window counter per key. One process; good enough until the server runs replicated. */
export class RateLimiter {
  private readonly hits = new Map<string, { window: number; n: number }>();
  check(key: string, perMin: number): { ok: boolean; retryAfterS: number } {
    const window = Math.floor(Date.now() / 60_000);
    const h = this.hits.get(key);
    if (!h || h.window !== window) {
      this.hits.set(key, { window, n: 1 });
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.window !== window) this.hits.delete(k);
      return { ok: true, retryAfterS: 0 };
    }
    h.n++;
    return { ok: h.n <= perMin, retryAfterS: 60 - Math.floor((Date.now() / 1000) % 60) };
  }
}

export function meta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers["user-agent"] ?? null };
}

export interface HttpOptions {
  rateLimitPerMin: number;
  loginRateLimitPerMin: number;
  secureCookies: boolean;
  hsts: boolean;
  /** Serve the web app: unknown GET paths outside /api return index.html. */
  spa?: boolean;
  /** Bearer token of the Prometheus scraper: accepted only at GET /metrics. */
  metricsToken?: string;
}

export function installHttp(app: FastifyInstance, auth: AuthService, o: HttpOptions): void {
  const limiter = new RateLimiter();
  app.decorateRequest("auth", null);

  // Security headers on every response
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    // a route may relax framing for itself (inline originals in the source view)
    if (!reply.hasHeader("x-frame-options")) reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    // answers of the API carry personal data: never kept by the browser or a proxy (ASVS 8.2.1)
    if (!reply.hasHeader("cache-control") && (_req.url.startsWith("/api/") || _req.url.startsWith("/mcp") || _req.url.startsWith("/metrics"))) reply.header("cache-control", "no-store");
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (o.hsts) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.addHook("onRequest", async (req, reply) => {
    const isLogin = req.url.startsWith("/api/auth/");
    // 1. who is calling
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    // the scraper token is not an API key: the route checks it itself
    if (o.metricsToken && bearer && req.method === "GET" && req.url === "/metrics" && sameSecret(bearer, o.metricsToken)) return;
    const sessionToken = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    req.auth = bearer || sessionToken ? await auth.authenticate({ bearer, sessionToken, ip: req.ip }) : null;
    if (bearer && !req.auth) throw new AuthError("unauthenticated", "Chiave API non valida, scaduta o non ammessa da questo indirizzo.");

    // 2. rate limit (logins per IP, the rest per principal or IP)
    const key = isLogin ? `login:${req.ip}` : req.auth ? `p:${req.auth.principal.id}` : `ip:${req.ip}`;
    const limit = isLogin ? o.loginRateLimitPerMin : (req.auth?.principal.ratePerMin ?? o.rateLimitPerMin);
    const rl = limiter.check(key, limit);
    if (!rl.ok) {
      reply.header("retry-after", String(rl.retryAfterS));
      throw new AuthError("locked", "Troppe richieste: attendi qualche secondo.", rl.retryAfterS * 1000);
    }

    // 3. CSRF: state-changing calls authenticated by cookie must echo the session's token
    // Login routes do not act on the current session (SameSite=Strict covers login CSRF);
    // logout does, so it stays protected.
    const csrfExempt = isLogin && !req.url.startsWith("/api/auth/logout");
    if (req.auth?.via === "session" && !csrfExempt && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const sent = req.headers[CSRF_HEADER];
      if (typeof sent !== "string" || sent !== req.auth.session!.csrf) {
        throw new AuthError("forbidden", "Richiesta non valida (token CSRF mancante o errato). Ricarica la pagina.");
      }
    }
  });

  // Request metrics: route template (bounded labels), status class, duration. The event
  // stream is long-lived and not a request latency.
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unknown";
    if (route === "/api/events") return;
    const labels = { route: route.startsWith("/api/") || route === "/mcp" || route === "/metrics" ? route : "static", method: req.method, status: `${Math.floor(reply.statusCode / 100)}xx` };
    metrics.inc("http_requests", labels);
    metrics.observe("http_request_ms", reply.elapsedTime, { route: labels.route });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AuthError) {
      if (err.retryAfterMs) reply.header("retry-after", String(Math.ceil(err.retryAfterMs / 1000)));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.status(400).send({ error: { code: "invalid_request", message: `Dati non validi: ${e.message}` } });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: "invalid_request", message: e.message } });
    log.error("request failed", { url: req.url, method: req.method, error: String(err), stack: (err as Error).stack?.split("\n").slice(0, 4).join(" | ") });
    return reply.status(500).send({ error: { code: "internal", message: "Errore interno. Il problema è stato registrato." } });
  });

  app.setNotFoundHandler((req, reply) => {
    // client-side routes of the web app: any GET outside /api answers with the app shell
    // (a missing file, e.g. a chunk of an older build, stays a 404: HTML in place of a script leaves a blank page)
    const pathOnly = req.url.split("?")[0]!;
    if (o.spa && req.method === "GET" && !pathOnly.startsWith("/api/") && !/\.[a-z0-9]{1,8}$/i.test(pathOnly)) return reply.header("cache-control", "no-cache").sendFile("index.html");
    return reply.status(404).send({ error: { code: "not_found", message: "Risorsa non trovata." } });
  });
}

export function setSessionCookies(reply: FastifyReply, s: { token: string; csrf: string; expiresAt: Date }, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, s.token, { httpOnly: true, secure, sameSite: "strict", path: "/", expires: s.expiresAt });
  reply.setCookie(CSRF_COOKIE, s.csrf, { httpOnly: false, secure, sameSite: "strict", path: "/", expires: s.expiresAt });
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", secure, sameSite: "strict" });
  reply.clearCookie(CSRF_COOKIE, { path: "/", secure, sameSite: "strict" });
}

export function requireAuth(req: FastifyRequest): Authenticated {
  if (!req.auth) throw new AuthError("unauthenticated", "Accesso richiesto.");
  return req.auth;
}

export function requireUser(req: FastifyRequest): Authenticated {
  const a = requireAuth(req);
  if (a.principal.kind !== "user") throw new AuthError("forbidden", "Operazione riservata agli utenti.");
  return a;
}

export function requireAction(req: FastifyRequest, action: Action, vaultId?: string): Authenticated {
  const a = requireAuth(req);
  // an account with the scope "projects" alone writes project documentation (routes/projects.ts) and nothing else
  if (a.principal.kind === "api" && a.principal.scopes.every((s) => s === "projects")) {
    throw new AuthError("forbidden", "Questo account API scrive solo la documentazione dei progetti.");
  }
  // "projects" writes project vaults only through the project routes and the MCP inbox: on the
  // other routes an account without "write" or "ingest" reads at most
  if (a.principal.kind === "api" && action !== "vault.read" && action.startsWith("vault.") && !a.principal.scopes.some((s) => s === "write" || s === "ingest")) {
    throw new AuthError("forbidden", "Questo account API può solo leggere: scrive solo la documentazione dei progetti e la inbox tramite MCP.");
  }
  Access.require(a.ctx, action, vaultId);
  return a;
}
