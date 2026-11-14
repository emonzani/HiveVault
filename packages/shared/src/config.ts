/**
 * Configuration from environment variables, with typed defaults.
 * Every setting is documented in .env.example.
 */

export function strEnv(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export function numEnv(name: string, fallback: number, opts: { min?: number; float?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = opts.float ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (opts.min !== undefined && n < opts.min) return opts.min;
  return n;
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function listEnv(name: string): string[] {
  return strEnv(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type OfflineMode = "mock" | "queue";
export type LocalSchedule = "always" | "off-hours" | "on-demand";

export interface ModelsConfig {
  chat: {
    url: string;
    modelId: string;
    parallelism: number;
    maxTokens: number;
    contextTokens: number;
    temperature: number;
    requestTimeoutMs: number;
    idleTimeoutMs: number;
    agingMs: number;
    /**
     * Small chat models for the extraction of sources and the short answers of the dream cycle
     * (M4, pool "extract"). Empty: the main chat model does that work too.
     */
    extractUrls: string[];
    /** Requests every extraction endpoint serves at the same time. */
    extractParallelism: number;
  };
  embed: { modelId: string; dimensions: number; remoteUrls: string[] };
  rerank: { modelId: string; remoteUrls: string[] };
  /** Vision endpoints that read scans and photos (OpenAI-compatible, images as data URLs). */
  ocr: {
    remoteUrls: string[];
    prompt: "generic" | "unlimited-ocr";
    /** Pages read together in one request: tables and paragraphs across pages stay whole. */
    pagesPerRequest: number;
    /** Render scale of PDF pages (1 = 72 dpi). */
    scale: number;
    /** Scanned pages read per document at most; the rest is marked "truncated". */
    maxPages: number;
  };
  local: {
    enabled: boolean;
    bin: string;
    modelsDir: string;
    embedPort: number;
    rerankPort: number;
    threads: number;
    schedule: LocalSchedule;
    offHours: string;
    extraArgs: string[];
  };
  apiKey: string;
  offlineMode: OfflineMode;
}

export function loadModelsConfig(): ModelsConfig {
  return {
    chat: {
      // no default host: an unset URL means no chat model, never a guessed address
      url: strEnv("LLAMA_SERVER_URL"),
      modelId: strEnv("LLAMA_MODEL_ID", "local-model"),
      parallelism: numEnv("LLAMA_PARALLELISM", 1, { min: 1 }),
      maxTokens: numEnv("LLAMA_MAX_TOKENS", 16384, { min: 1 }),
      contextTokens: numEnv("LLAMA_CONTEXT_TOKENS", 0, { min: 0 }),
      temperature: numEnv("LLAMA_TEMPERATURE", 0.2, { min: 0, float: true }),
      requestTimeoutMs: numEnv("LLAMA_REQUEST_TIMEOUT_MS", 20 * 60 * 1000, { min: 1000 }),
      idleTimeoutMs: numEnv("LLAMA_IDLE_TIMEOUT_MS", 3 * 60 * 1000, { min: 1000 }),
      agingMs: numEnv("LLAMA_AGING_MS", 10 * 60 * 1000, { min: 0 }),
      extractUrls: listEnv("CHAT_EXTRACT_URLS"),
      extractParallelism: numEnv("CHAT_EXTRACT_PARALLELISM", 1, { min: 1 }),
    },
    embed: {
      modelId: strEnv("EMBED_MODEL_ID", "Qwen3-Embedding-0.6B-Q8_0.gguf"),
      dimensions: numEnv("EMBED_DIMENSIONS", 1024, { min: 1 }),
      remoteUrls: listEnv("REMOTE_EMBED_URLS"),
    },
    rerank: {
      modelId: strEnv("RERANK_MODEL_ID", "Qwen3-Reranker-0.6B-Q8_0.gguf"),
      remoteUrls: listEnv("REMOTE_RERANK_URLS"),
    },
    ocr: {
      remoteUrls: listEnv("OCR_URLS"),
      prompt: (strEnv("OCR_PROMPT", "generic") as "generic" | "unlimited-ocr"),
      pagesPerRequest: numEnv("OCR_PAGES_PER_REQUEST", 4, { min: 1 }),
      scale: numEnv("OCR_RENDER_SCALE", 2, { min: 0.5, float: true }),
      maxPages: numEnv("OCR_MAX_PAGES", 500, { min: 1 }),
    },
    local: {
      enabled: boolEnv("LOCAL_MODELS_ENABLED", false),
      bin: strEnv("LOCAL_LLAMA_BIN", "llama-server"),
      modelsDir: strEnv("LOCAL_MODELS_DIR", "data/models"),
      embedPort: numEnv("LOCAL_EMBED_PORT", 18001, { min: 1 }),
      rerankPort: numEnv("LOCAL_RERANK_PORT", 18002, { min: 1 }),
      threads: numEnv("LOCAL_MODELS_THREADS", 8, { min: 1 }),
      schedule: (strEnv("LOCAL_MODELS_SCHEDULE", "always") as LocalSchedule),
      offHours: strEnv("LOCAL_MODELS_OFF_HOURS", "19:00-07:00"),
      extraArgs: strEnv("LOCAL_LLAMA_EXTRA_ARGS", "--device none").split(/\s+/).filter(Boolean),
    },
    apiKey: strEnv("MODELS_API_KEY"),
    offlineMode: (strEnv("MODELS_OFFLINE_MODE", "mock") as OfflineMode),
  };
}

export function databaseUrl(): string {
  return strEnv("DATABASE_URL", "postgres://brain:brain@127.0.0.1:5432/brain");
}
