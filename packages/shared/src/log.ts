/** Minimal structured logger: one JSON line per event, level filter from LOG_LEVEL. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const l = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
  return ORDER[l] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Field names that carry secrets: their values never reach the log (ASVS 7.1.1). */
const SECRET = /^(password|passwd|secret|token|apikey|api_key|key|authorization|cookie|code|totp|csrf|recoverycode)s?$/i;

/** Replaces the values of secret fields, at any depth, and Bearer tokens inside strings. */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1[nascosto]").replace(/\bcb_[A-Za-z0-9]+_[A-Za-z0-9_-]{16,}/g, "cb_[nascosto]");
  if (!v || typeof v !== "object" || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? "[nascosto]" : redact(x, depth + 1)]));
}

export function createLogger(scope: string): Logger {
  const emit = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < threshold()) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...(data ? (redact(data) as Record<string, unknown>) : {}) });
    // LOG_STREAM=stderr: every line to stderr (a CLI command whose stdout is its answer)
    (level === "error" || level === "warn" || process.env.LOG_STREAM === "stderr" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (s) => createLogger(`${scope}.${s}`),
  };
}
