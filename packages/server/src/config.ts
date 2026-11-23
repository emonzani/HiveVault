import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { boolEnv, listEnv, numEnv, strEnv } from "@cb/shared";

export interface ServerConfig {
  host: string;
  port: number;
  /** Public URL of the web app, e.g. https://brain.azienda.local — origin for WebAuthn and CORS-free same-site cookies. */
  publicUrl: string;
  /** WebAuthn relying party id: the host name of publicUrl. */
  rpId: string;
  /** Extra origins accepted for WebAuthn and the signature login (dev server of the SPA). */
  extraOrigins: string[];
  tls: { cert: Buffer; key: Buffer } | null;
  /** Addresses (IP or CIDR) of the reverse proxies in front of the server (TRUST_PROXY); empty = no proxy. */
  trustProxy: string[];
  sessionIdleMs: number;
  sessionMaxMs: number;
  rateLimitPerMin: number;
  loginRateLimitPerMin: number;
  clientCaFile: string;
  dataDir: string;
  /** Extra hosts the server may connect to (besides database and model servers). */
  egressAllow: string[];
  uploadMaxBytes: number;
  compileUploads: boolean;
  /** extract: JSON extraction merged by code (default); agent: the model writes the pages with tools. */
  compileMode: "extract" | "agent";
  ingestWorkers: number;
  parserThreads: number;
  /** Folders (absolute) under which bulk imports may read. Empty = imports disabled. */
  importRoots: string[];
  /** Built web app; empty = API only. */
  webDir: string;
  /** Bearer token for Prometheus at GET /metrics (empty = administrators only). */
  metricsToken: string;
  /** Dream cycle (plan §5): night window, budget per vault and night, retention. */
  dream: { enabled: boolean; window: string; minutes: number; tokens: number; compilePerNight: number; useModel: boolean; auditDays: number; taskDays: number };
  /** Links during the day (crosslink, claims, hive promotion of the changed pages): minutes between passes, 0 = off. */
  linkIntervalMinutes: number;
  /** Sources never asked to compile (imports) compiled while the chat model is free (M3). */
  idleCompile: boolean;
  /**
   * Privacy (docs/sicurezza/privacy.md): days read events (page.read, search, ...) stay in the audit log,
   * and whether email files (EML, MSG, MBOX) are ingested. The console can change both.
   */
  privacy: { readRetentionDays: number; emailIngest: boolean };
}

/**
 * TRUST_PROXY: addresses (IP or CIDR range, comma separated) of the reverse proxies in front of
 * the server. req.ip is then the rightmost X-Forwarded-For address that is not a listed proxy,
 * so a client cannot choose it. Unset or "false": no proxy, req.ip is the socket address.
 * The old value "true" trusted every hop: req.ip was the leftmost entry, which the client writes.
 * It does not say where the proxy is, so it is refused, not guessed. An invalid entry is refused
 * too. A refusal throws, and the server does not start.
 */
export function parseTrustProxy(raw: string | undefined): string[] {
  const value = raw?.trim() ?? "";
  const lower = value.toLowerCase();
  if (!value || ["false", "0", "no", "off"].includes(lower)) return [];
  if (["true", "1", "yes", "on"].includes(lower)) {
    throw new Error(
      `TRUST_PROXY=${value} is no longer accepted: it let any client choose its IP address with X-Forwarded-For. ` +
        "Set TRUST_PROXY to the addresses of the reverse proxy (IP or CIDR range, comma separated), " +
        "e.g. TRUST_PROXY=127.0.0.1,::1 for a proxy on this server, and make the proxy overwrite X-Forwarded-For. " +
        "Without a reverse proxy, set TRUST_PROXY=false.",
    );
  }
  const list = value.split(",").map((s) => s.trim());
  for (const entry of list) {
    const slash = entry.indexOf("/");
    const addr = slash < 0 ? entry : entry.slice(0, slash);
    const family = isIP(addr);
    const max = family === 6 ? 128 : 32;
    const prefix = slash < 0 ? String(max) : entry.slice(slash + 1);
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : -1;
    if (!family || bits < 0 || bits > max) {
      throw new Error(`TRUST_PROXY: "${entry}" is not an IP address or a CIDR range (e.g. 127.0.0.1, 10.0.0.0/24, ::1).`);
    }
    // a /0 range, or an IPv6 range that holds every IPv4-mapped address (::ffff:0:0/96), trusts any client
    const mapped = new BlockList();
    if (family === 6 && bits <= 96) mapped.addSubnet(addr, bits, "ipv6");
    if (bits === 0 || mapped.check("::ffff:0:0", "ipv6")) {
      throw new Error(`TRUST_PROXY: "${entry}" covers every client address. List only the addresses of the reverse proxies.`);
    }
  }
  return list;
}

export function loadServerConfig(): ServerConfig {
  const certFile = strEnv("TLS_CERT_FILE");
  const keyFile = strEnv("TLS_KEY_FILE");
  const tls = certFile && keyFile ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : null;
  const port = numEnv("PORT", 3700, { min: 1 });
  const publicUrl = strEnv("PUBLIC_URL", `${tls ? "https" : "http"}://localhost:${port}`).replace(/\/+$/, "");
  return {
    host: strEnv("HOST", "127.0.0.1"),
    port,
    publicUrl,
    rpId: strEnv("WEBAUTHN_RP_ID", new URL(publicUrl).hostname),
    extraOrigins: listEnv("WEBAUTHN_EXTRA_ORIGINS"),
    tls,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    sessionIdleMs: numEnv("SESSION_IDLE_MINUTES", 12 * 60, { min: 1 }) * 60_000,
    sessionMaxMs: numEnv("SESSION_MAX_HOURS", 7 * 24, { min: 1 }) * 3600_000,
    rateLimitPerMin: numEnv("RATE_LIMIT_PER_MIN", 600, { min: 1 }),
    loginRateLimitPerMin: numEnv("LOGIN_RATE_LIMIT_PER_MIN", 20, { min: 1 }),
    clientCaFile: strEnv("CLIENT_CA_FILE"),
    dataDir: strEnv("DATA_DIR", "data"),
    egressAllow: listEnv("EGRESS_ALLOW"),
    uploadMaxBytes: numEnv("UPLOAD_MAX_MB", 500, { min: 1 }) * 1024 ** 2,
    compileUploads: boolEnv("COMPILE_UPLOADS", true),
    compileMode: strEnv("COMPILE_MODE", "extract") === "agent" ? "agent" : "extract",
    ingestWorkers: numEnv("INGEST_WORKERS", 4, { min: 1 }),
    parserThreads: numEnv("PARSER_THREADS", 4, { min: 1 }),
    importRoots: listEnv("IMPORT_ROOTS"),
    webDir: strEnv("WEB_DIR", "packages/web/dist"),
    metricsToken: strEnv("METRICS_TOKEN"),
    dream: {
      enabled: boolEnv("DREAM_ENABLED", true),
      window: strEnv("DREAM_WINDOW", "22:00-06:00"),
      minutes: numEnv("DREAM_BUDGET_MINUTES", 120, { min: 1 }),
      tokens: numEnv("DREAM_BUDGET_TOKENS", 300_000, { min: 0 }),
      compilePerNight: numEnv("DREAM_COMPILE_PER_NIGHT", 20, { min: 0 }),
      useModel: boolEnv("DREAM_USE_MODEL", true),
      // security events: at least 6 months (Garante, system administrators, 27/11/2008)
      auditDays: numEnv("AUDIT_RETENTION_DAYS", 400, { min: 183 }),
      taskDays: numEnv("TASK_RETENTION_DAYS", 30, { min: 1 }),
    },
    linkIntervalMinutes: numEnv("LINK_INTERVAL_MINUTES", 5, { min: 0 }),
    idleCompile: boolEnv("IDLE_COMPILE", true),
    privacy: {
      readRetentionDays: numEnv("AUDIT_READ_RETENTION_DAYS", 30, { min: 1 }),
      emailIngest: boolEnv("INGEST_EMAIL", true),
    },
  };
}
