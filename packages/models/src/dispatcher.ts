import { createLogger, metrics } from "@cb/shared";
import type {
  ChatRequest,
  ChatResponse,
  EmbedResponse,
  Endpoint,
  ModelKind,
  OcrRequest,
  OcrResponse,
  Priority,
  RerankResponse,
} from "./types.ts";
import { normalizeModelName, truncateAndNormalize } from "./types.ts";

/**
 * One queue per model kind, many endpoints per kind (local and remote).
 *
 * - Priority with aging: a waiting job gains one level every `agingMs`.
 * - Work pulling: an endpoint with a free slot takes the next job. Fast endpoints free their
 *   slots sooner and so take more batches: throughput splits by measured speed without tuning.
 * - Interactive jobs (effective priority 0) go to the free endpoint with the lowest latency.
 * - Identity check: an embedding/rerank endpoint serves only when its model is the expected one.
 *   Vectors from different models are not comparable (AGENTS.md invariant 3).
 * - Fallback endpoints (mock) serve a kind only when it has no real endpoint at all, or for chat
 *   when every chat endpoint is down and offlineMode is "mock". Embeddings never mix models.
 * - Pools (M4): an endpoint added with a pool (e.g. "extract": a small chat model on another
 *   host) serves only the jobs that ask for that pool. Such a job goes to its pool while one of
 *   its endpoints is up, else to the endpoints without a pool. Jobs without a pool never use a
 *   pool endpoint: the large model stays for the questions. Without pool endpoints nothing changes.
 */

export type EndpointStatus = "unknown" | "up" | "down" | "mismatch";

export interface EndpointStats {
  id: string;
  kind: ModelKind;
  origin: string;
  url: string;
  status: EndpointStatus;
  reason?: string;
  /** Pool the endpoint serves (M4); absent for the general endpoints. */
  pool?: string;
  slots: number;
  inflight: number;
  requests: number;
  errors: number;
  items: number;
  latencyMs: number | null;
  itemsPerSec: number | null;
}

export interface DispatcherOptions {
  expected: {
    embed?: { model: string; dimensions: number };
    rerank?: { model: string };
  };
  agingMs?: number;
  healthIntervalMs?: number;
  offlineMode?: "mock" | "queue";
  maxAttempts?: number;
  /**
   * Slots of every endpoint kept free for interactive jobs (effective priority 0). Background
   * jobs never take them, so a query does not wait behind a running batch. An endpoint always
   * keeps at least one slot for background work (a 1-slot endpoint reserves nothing).
   */
  reserveInteractive?: Partial<Record<ModelKind, number>>;
  /**
   * Background embedding batches are split into requests of at most this many texts.
   * llama-server queues the texts of a request FIFO inside the server: short requests keep
   * that queue short, so an interactive query waits for at most one round of the slots.
   * Throughput does not change (llama-server batches across slots). Spike D: 16 texts per
   * request -> query p95 4.2 s during a backfill; 2 texts -> 0.64 s, same tokens/s.
   */
  backgroundItemsPerRequest?: number;
}

export interface CallOptions {
  priority?: Priority;
  signal?: AbortSignal;
  /** Pool of endpoints that serves the job first (M4), e.g. "extract". */
  pool?: string;
}

interface Slot {
  ep: Endpoint;
  fallback: boolean;
  pool: string | undefined;
  status: EndpointStatus;
  reason?: string;
  inflight: number;
  requests: number;
  errors: number;
  items: number;
  consecutiveFailures: number;
  latencyMs: number | null;
  itemsPerSec: number | null;
  checking: boolean;
  lastCheck: number;
}

interface Job {
  kind: ModelKind;
  priority: Priority;
  pool: string | undefined;
  enqueuedAt: number;
  seq: number;
  attempts: number;
  items: number;
  signal: AbortSignal | undefined;
  run: (ep: Endpoint, signal: AbortSignal | undefined) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const EWMA = 0.3;
/** 1x1 white PNG: the console test of an OCR endpoint. */
const TEST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==", "base64");
const log = createLogger("models.dispatcher");

export class NoEndpointError extends Error {
  constructor(kind: ModelKind) {
    super(`No ${kind} endpoint is available`);
    this.name = "NoEndpointError";
  }
}

export class ModelDispatcher {
  private readonly slots = new Map<string, Slot>();
  private readonly queues: Record<ModelKind, Job[]> = { chat: [], embed: [], rerank: [], ocr: [] };
  private readonly opts: Required<Omit<DispatcherOptions, "expected" | "reserveInteractive">> & Pick<DispatcherOptions, "expected">;
  private readonly reserve: Record<ModelKind, number>;
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private stopped = false;

  constructor(opts: DispatcherOptions) {
    this.opts = {
      expected: opts.expected,
      agingMs: opts.agingMs ?? 10 * 60 * 1000,
      healthIntervalMs: opts.healthIntervalMs ?? 10_000,
      offlineMode: opts.offlineMode ?? "mock",
      maxAttempts: opts.maxAttempts ?? 3,
      backgroundItemsPerRequest: opts.backgroundItemsPerRequest ?? 2,
    };
    this.reserve = { chat: 0, embed: 1, rerank: 1, ocr: 0, ...opts.reserveInteractive };
  }

  /** Starts the periodic health check. Endpoints are also checked when they are added. */
  start(): this {
    this.timer ??= setInterval(() => void this.checkAll(), this.opts.healthIntervalMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const q of Object.values(this.queues)) {
      for (const j of q.splice(0)) j.reject(new Error("Dispatcher stopped"));
    }
  }

  addEndpoint(ep: Endpoint, opts: { fallback?: boolean; pool?: string } = {}): Promise<EndpointStatus> {
    if (this.slots.has(ep.id)) throw new Error(`Endpoint ${ep.id} already registered`);
    const slot: Slot = {
      ep,
      fallback: opts.fallback ?? false,
      pool: opts.pool || undefined,
      status: "unknown",
      inflight: 0,
      requests: 0,
      errors: 0,
      items: 0,
      consecutiveFailures: 0,
      latencyMs: null,
      itemsPerSec: null,
      checking: false,
      lastCheck: 0,
    };
    this.slots.set(ep.id, slot);
    return this.check(slot);
  }

  removeEndpoint(id: string): void {
    this.slots.delete(id);
  }

  /**
   * Console test of one endpoint, outside the queues: health, identity and one tiny request.
   * The chat test asks for 8 tokens without reasoning (it still waits for the single slot).
   */
  async testEndpoint(id: string, timeoutMs = 60_000): Promise<{ ok: boolean; health: boolean; model?: string; ms?: number; error?: string }> {
    const s = this.slots.get(id);
    if (!s) return { ok: false, health: false, error: "endpoint non registrato" };
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const health = await s.ep.health(signal);
      if (!health) return { ok: false, health };
      const idn = await s.ep.identity(signal);
      const t0 = performance.now();
      if (s.ep.kind === "embed") await s.ep.embed!({ texts: ["prova di HiveVault"] }, signal);
      else if (s.ep.kind === "rerank") await s.ep.rerank!({ query: "prova", documents: ["prova di HiveVault", "altro"] }, signal);
      else if (s.ep.kind === "ocr") await s.ep.ocr!({ images: [{ data: TEST_PNG, mime: "image/png" }], maxTokens: 16 }, signal);
      else await s.ep.chat!({ messages: [{ role: "user", content: "Rispondi solo: ok" }], maxTokens: 8, temperature: 0, thinking: false }, signal);
      return { ok: true, health, model: idn.model, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, health: false, error: String((e as Error).message ?? e) };
    }
  }

  /** Marks an endpoint for an immediate re-check (e.g. after the supervisor restarted it). */
  async recheck(id: string): Promise<EndpointStatus | undefined> {
    const s = this.slots.get(id);
    if (!s) return undefined;
    s.status = "unknown";
    (s.ep as { resetIdentity?: () => void }).resetIdentity?.();
    return this.check(s);
  }

  // ---------------------------------------------------------------------------
  // Public calls
  // ---------------------------------------------------------------------------

  chat(req: ChatRequest, o: CallOptions = {}): Promise<ChatResponse> {
    return this.enqueue("chat", 1, o, (ep, signal) => {
      if (!ep.chat) throw new Error(`${ep.id} cannot chat`);
      return ep.chat(req, signal);
    });
  }

  async embed(texts: string[], o: CallOptions = {}): Promise<EmbedResponse> {
    if (texts.length === 0) return { vectors: [], model: this.opts.expected.embed?.model ?? "", tokens: 0 };
    const dims = this.opts.expected.embed?.dimensions;
    const per = (o.priority ?? 1) === 0 ? texts.length : Math.max(1, this.opts.backgroundItemsPerRequest);
    const parts: string[][] = [];
    for (let i = 0; i < texts.length; i += per) parts.push(texts.slice(i, i + per));
    const results = await Promise.all(
      parts.map((part) =>
        this.enqueue<EmbedResponse>("embed", part.length, o, (ep, signal) => {
          if (!ep.embed) throw new Error(`${ep.id} cannot embed`);
          return ep.embed({ texts: part }, signal);
        }),
      ),
    );
    const models = new Set(results.map((r) => r.model));
    if (models.size > 1) throw new IdentityMismatchError(`one batch was embedded by different models: ${[...models].join(", ")}`);
    const vectors = results.flatMap((r) => r.vectors);
    return {
      vectors: dims ? vectors.map((v) => truncateAndNormalize(v, dims)) : vectors,
      model: results[0]!.model,
      tokens: results.reduce((n, r) => n + r.tokens, 0),
    };
  }

  rerank(query: string, documents: string[], o: CallOptions = {}): Promise<RerankResponse> {
    return this.enqueue("rerank", documents.length, o, (ep, signal) => {
      if (!ep.rerank) throw new Error(`${ep.id} cannot rerank`);
      return ep.rerank({ query, documents }, signal);
    });
  }

  /** Text of page images (scans, photos). Background work: ingestion priority by default. */
  ocr(req: OcrRequest, o: CallOptions = {}): Promise<OcrResponse> {
    return this.enqueue("ocr", req.images.length, o, (ep, signal) => {
      if (!ep.ocr) throw new Error(`${ep.id} cannot read images`);
      return ep.ocr(req, signal);
    });
  }

  snapshot(): { endpoints: EndpointStats[]; queues: Record<ModelKind, Record<Priority, number>> } {
    const queues = { chat: { 0: 0, 1: 0, 2: 0 }, embed: { 0: 0, 1: 0, 2: 0 }, rerank: { 0: 0, 1: 0, 2: 0 }, ocr: { 0: 0, 1: 0, 2: 0 } } as Record<
      ModelKind,
      Record<Priority, number>
    >;
    for (const [kind, q] of Object.entries(this.queues) as [ModelKind, Job[]][]) {
      for (const j of q) queues[kind][j.priority]++;
    }
    const endpoints = [...this.slots.values()].map<EndpointStats>((s) => ({
      id: s.ep.id,
      kind: s.ep.kind,
      origin: s.ep.origin,
      url: s.ep.url,
      status: s.status,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.pool ? { pool: s.pool } : {}),
      slots: s.ep.slots,
      inflight: s.inflight,
      requests: s.requests,
      errors: s.errors,
      items: s.items,
      latencyMs: s.latencyMs,
      itemsPerSec: s.itemsPerSec,
    }));
    return { endpoints, queues };
  }

  // ---------------------------------------------------------------------------
  // Queue and scheduling
  // ---------------------------------------------------------------------------

  private enqueue<T>(kind: ModelKind, items: number, o: CallOptions, run: Job["run"]): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Dispatcher stopped"));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        kind,
        priority: o.priority ?? 1,
        pool: o.pool || undefined,
        enqueuedAt: Date.now(),
        seq: this.seq++,
        attempts: 0,
        items,
        signal: o.signal,
        run,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      if (o.signal) {
        if (o.signal.aborted) return reject(o.signal.reason);
        o.signal.addEventListener(
          "abort",
          () => {
            const q = this.queues[kind];
            const i = q.indexOf(job);
            if (i >= 0) {
              q.splice(i, 1);
              reject(o.signal!.reason);
            }
          },
          { once: true },
        );
      }
      this.queues[kind].push(job);
      if (!this.usable(kind, job.pool).length && this.opts.offlineMode === "queue" && !this.hasAnyEndpoint(kind)) {
        // Nothing will ever serve this kind: fail fast instead of waiting forever.
        this.queues[kind].pop();
        return reject(new NoEndpointError(kind));
      }
      this.pump(kind);
    });
  }

  private effectivePriority(j: Job, now: number): number {
    if (this.opts.agingMs <= 0) return j.priority;
    return Math.max(0, j.priority - Math.floor((now - j.enqueuedAt) / this.opts.agingMs));
  }

  /** Index of the next job: lowest effective priority, then oldest. */
  private bestJobIndex(kind: ModelKind): number {
    const q = this.queues[kind];
    if (q.length === 0) return -1;
    const now = Date.now();
    let best = 0;
    let bestP = this.effectivePriority(q[0]!, now);
    for (let i = 1; i < q.length; i++) {
      const p = this.effectivePriority(q[i]!, now);
      if (p < bestP || (p === bestP && q[i]!.seq < q[best]!.seq)) {
        best = i;
        bestP = p;
      }
    }
    return best;
  }

  private backgroundCapacity(s: Slot): number {
    return s.ep.slots - Math.min(this.reserve[s.ep.kind], s.ep.slots - 1);
  }

  private hasAnyEndpoint(kind: ModelKind): boolean {
    for (const s of this.slots.values()) if (s.ep.kind === kind) return true;
    return false;
  }

  private hasPools(kind: ModelKind): boolean {
    for (const s of this.slots.values()) if (s.ep.kind === kind && s.pool) return true;
    return false;
  }

  /**
   * Endpoints that may serve a job of `kind` (and `pool`) now, before the slot check. A job of a
   * pool goes to that pool while one of its real endpoints is up; every other job, and a job
   * whose pool is down, goes to the endpoints without a pool.
   */
  private usable(kind: ModelKind, pool?: string): Slot[] {
    let all = [...this.slots.values()].filter((s) => s.ep.kind === kind);
    if (all.some((s) => s.pool)) {
      const own = pool ? all.filter((s) => s.pool === pool) : [];
      all = own.some((s) => !s.fallback && s.status === "up") ? own : all.filter((s) => !s.pool);
    }
    const real = all.filter((s) => !s.fallback);
    const realUp = real.filter((s) => s.status === "up");
    if (realUp.length) return realUp;
    const fallbackAllowed =
      real.length === 0 || (kind === "chat" && this.opts.offlineMode === "mock");
    return fallbackAllowed ? all.filter((s) => s.fallback && s.status === "up") : [];
  }

  /**
   * True while a new job of `kind` (and `pool`) would wait: every real endpoint that would serve
   * it is busy, or jobs already wait for them. False without real endpoints.
   */
  busy(kind: ModelKind, pool?: string): boolean {
    const lane = this.usable(kind, pool).filter((s) => !s.fallback);
    if (!lane.length) return false;
    if (this.queues[kind].some((j) => this.usable(kind, j.pool).some((s) => lane.includes(s)))) return true;
    return lane.every((s) => s.inflight >= s.ep.slots);
  }

  private pump(kind: ModelKind): void {
    if (this.hasPools(kind)) return this.pumpPools(kind);
    for (;;) {
      const free = this.usable(kind).filter((s) => s.inflight < s.ep.slots);
      if (free.length === 0) return;
      const idx = this.bestJobIndex(kind);
      if (idx < 0) return;
      const job = this.queues[kind][idx]!;
      const priority = this.effectivePriority(job, Date.now());
      // Background jobs cannot use the slots reserved for interactive jobs.
      const eligible = priority === 0 ? free : free.filter((s) => s.inflight < this.backgroundCapacity(s));
      if (eligible.length === 0) return; // the best job is background and only reserved slots are free
      this.queues[kind].splice(idx, 1);
      void this.execute(this.choose(eligible, priority), job);
    }
  }

  /**
   * pump() with pools: the jobs in priority order, each to a free endpoint of its own lane. A
   * job whose lane is full does not stop the jobs of the other lane.
   */
  private pumpPools(kind: ModelKind): void {
    for (;;) {
      const now = Date.now();
      const order = this.queues[kind]
        .map((job) => ({ job, p: this.effectivePriority(job, now) }))
        .sort((a, b) => a.p - b.p || a.job.seq - b.job.seq);
      let started = false;
      for (const { job, p } of order) {
        const free = this.usable(kind, job.pool).filter((s) => s.inflight < s.ep.slots);
        const eligible = p === 0 ? free : free.filter((s) => s.inflight < this.backgroundCapacity(s));
        if (!eligible.length) continue;
        this.queues[kind].splice(this.queues[kind].indexOf(job), 1);
        void this.execute(this.choose(eligible, p), job);
        started = true;
        break;
      }
      if (!started) return;
    }
  }

  private choose(free: Slot[], priority: number): Slot {
    if (priority === 0) {
      // lowest latency; unknown latency counts as 0 so that new endpoints get measured
      return free.reduce((a, b) => ((b.latencyMs ?? 0) < (a.latencyMs ?? 0) ? b : a));
    }
    const score = (s: Slot) => (s.itemsPerSec ?? Number.POSITIVE_INFINITY) / (s.inflight + 1);
    return free.reduce((a, b) => (score(b) > score(a) ? b : a));
  }

  private async execute(slot: Slot, job: Job): Promise<void> {
    slot.inflight++;
    slot.requests++;
    job.attempts++;
    const started = performance.now();
    try {
      const result = await job.run(slot.ep, job.signal);
      this.verifyResultModel(slot, result);
      const ms = performance.now() - started;
      slot.latencyMs = slot.latencyMs === null ? ms : slot.latencyMs * (1 - EWMA) + ms * EWMA;
      const ips = (job.items * 1000) / Math.max(ms, 1);
      slot.itemsPerSec = slot.itemsPerSec === null ? ips : slot.itemsPerSec * (1 - EWMA) + ips * EWMA;
      slot.items += job.items;
      slot.consecutiveFailures = 0;
      metrics.observe("model_request_ms", ms, { endpoint: slot.ep.id, kind: job.kind });
      metrics.inc("model_items", { endpoint: slot.ep.id, kind: job.kind }, job.items);
      const usage = (result as { usage?: { promptTokens?: number; completionTokens?: number } } | null)?.usage;
      if (usage) {
        metrics.inc("model_tokens", { endpoint: slot.ep.id, type: "prompt" }, usage.promptTokens ?? 0);
        metrics.inc("model_tokens", { endpoint: slot.ep.id, type: "completion" }, usage.completionTokens ?? 0);
      }
      const inputTokens = (result as { tokens?: number } | null)?.tokens;
      if (typeof inputTokens === "number") metrics.inc("model_tokens", { endpoint: slot.ep.id, type: "input" }, inputTokens);
      job.resolve(result);
    } catch (err) {
      if (job.signal?.aborted) {
        job.reject(job.signal.reason);
      } else {
        slot.errors++;
        slot.consecutiveFailures++;
        metrics.inc("model_errors", { endpoint: slot.ep.id, kind: job.kind });
        if (slot.consecutiveFailures >= 2 || err instanceof IdentityMismatchError) {
          this.markDown(slot, err instanceof IdentityMismatchError ? "mismatch" : "down", String((err as Error).message ?? err));
        }
        if (job.attempts < this.opts.maxAttempts && !(err instanceof IdentityMismatchError && !this.usable(job.kind, job.pool).length)) {
          log.warn("retry", { endpoint: slot.ep.id, attempt: job.attempts, error: String((err as Error).message ?? err) });
          this.queues[job.kind].unshift(job);
        } else {
          job.reject(err);
        }
      }
    } finally {
      slot.inflight--;
      this.pump(job.kind);
    }
  }

  private verifyResultModel(slot: Slot, result: unknown): void {
    const k = slot.ep.kind;
    if (k !== "embed" && k !== "rerank") return;
    const expected = this.opts.expected[k]?.model;
    if (!expected || slot.fallback) return;
    const got = (result as { model?: string }).model;
    if (got && normalizeModelName(got) !== normalizeModelName(expected)) {
      throw new IdentityMismatchError(`${slot.ep.id} answered with model ${got}, expected ${expected}`);
    }
  }

  private markDown(slot: Slot, status: "down" | "mismatch", reason: string): void {
    if (slot.status !== status) log.warn("endpoint unavailable", { endpoint: slot.ep.id, status, reason });
    slot.status = status;
    slot.reason = reason;
  }

  // ---------------------------------------------------------------------------
  // Health and identity
  // ---------------------------------------------------------------------------

  private async checkAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((s) => this.check(s)));
  }

  private async check(slot: Slot): Promise<EndpointStatus> {
    if (slot.checking) return slot.status;
    slot.checking = true;
    try {
      const healthy = await slot.ep.health();
      slot.lastCheck = Date.now();
      if (!healthy) {
        this.markDown(slot, "down", "health check failed");
        return slot.status;
      }
      if (slot.status === "up") return slot.status;
      const problem = await this.identityProblem(slot);
      if (problem) {
        this.markDown(slot, "mismatch", problem);
      } else {
        log.info("endpoint up", { endpoint: slot.ep.id, origin: slot.ep.origin });
        slot.status = "up";
        delete slot.reason;
        slot.consecutiveFailures = 0;
        this.pump(slot.ep.kind);
      }
      return slot.status;
    } catch (err) {
      this.markDown(slot, "down", String((err as Error).message ?? err));
      return slot.status;
    } finally {
      slot.checking = false;
    }
  }

  private async identityProblem(slot: Slot): Promise<string | undefined> {
    const kind = slot.ep.kind;
    if (slot.fallback || kind === "chat" || kind === "ocr") return undefined;
    const exp = this.opts.expected[kind];
    if (!exp) return undefined;
    const id = await slot.ep.identity();
    if (id.model !== normalizeModelName(exp.model)) {
      return `model ${id.model} is different from the expected ${normalizeModelName(exp.model)}`;
    }
    if (kind === "embed") {
      const dims = (exp as { dimensions: number }).dimensions;
      if (!id.dimensions || id.dimensions < dims) {
        return `vector size ${id.dimensions ?? "?"} is smaller than EMBED_DIMENSIONS=${dims}`;
      }
    }
    return undefined;
  }
}

export class IdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityMismatchError";
  }
}
