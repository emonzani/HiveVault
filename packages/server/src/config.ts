import { readFileSync } from "node:fs";
import { boolEnv, listEnv, numEnv, strEnv } from "@cb/shared";

export interface ServerConfig {
  host: string;
  port: number;
  /** Public URL of the web app, e.g. https://brain.azienda.local — origin for WebAuthn and CORS-free same-site cookies. */
  publicUrl: string;
  /** WebAuthn relying party id: the host name of publicUrl. */
  rpId: string;
  /** Extra origins accepted for WebAuthn (dev server of the SPA). */
  extraOrigins: string[];
  tls: { cert: Buffer; key: Buffer } | null;
  trustProxy: boolean;
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
    trustProxy: boolEnv("TRUST_PROXY", false),
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
