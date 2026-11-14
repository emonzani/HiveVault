import { createHash } from "node:crypto";
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  Endpoint,
  ModelIdentity,
  ModelKind,
  OcrRequest,
  OcrResponse,
  RerankRequest,
  RerankResponse,
} from "./types.ts";

/**
 * Deterministic fake models for development and tests (MODELS_OFFLINE_MODE=mock).
 *
 * Embeddings use feature hashing of words and character trigrams: texts that share words get
 * similar vectors, so search tests behave like a weak real model. The same text always gives
 * the same vector. Chat answers come from recorded fixtures, else a deterministic summary.
 */
export const MOCK_EMBED_MODEL = "mock-embed-hash-v1";
export const MOCK_RERANK_MODEL = "mock-rerank-overlap-v1";
export const MOCK_CHAT_MODEL = "mock-chat-v1";
export const MOCK_OCR_MODEL = "mock-ocr-v1";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

function hash32(s: string): number {
  return createHash("md5").update(s).digest().readUInt32LE(0);
}

export function mockEmbedding(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const ws = words(text);
  const add = (feature: string, weight: number) => {
    const h = hash32(feature);
    v[h % dims]! += h & 0x80000000 ? -weight : weight;
  };
  for (const w of ws) {
    add(`w:${w}`, 1);
    for (let i = 0; i + 3 <= w.length; i++) add(`t:${w.slice(i, i + 3)}`, 0.3);
  }
  if (ws.length === 0) add("empty", 1);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export interface MockEndpointOptions {
  kind: ModelKind;
  id?: string;
  dimensions?: number;
  /** Simulated latency per request (ms) and per item (ms), to test scheduling. */
  latencyMs?: number;
  perItemMs?: number;
  slots?: number;
  /** Override of the reported model name, to test identity checks. */
  modelName?: string;
  /** prompt hash (sha256 of the last user message) -> recorded answer */
  fixtures?: Map<string, string>;
  /** Scripted chat (tests of agents): returns the next response, tool calls included. */
  script?: (req: ChatRequest, turn: number) => Partial<ChatResponse>;
  failRate?: number;
}

export class MockEndpoint implements Endpoint {
  readonly id: string;
  readonly kind: ModelKind;
  readonly origin = "mock" as const;
  readonly url: string;
  readonly slots: number;
  private readonly dims: number;
  private readonly latencyMs: number;
  private readonly perItemMs: number;
  private readonly modelName: string;
  private readonly fixtures: Map<string, string>;
  private readonly failRate: number;
  private readonly script: MockEndpointOptions["script"];
  private turn = 0;
  up = true;
  calls = 0;

  constructor(o: MockEndpointOptions) {
    this.kind = o.kind;
    this.id = o.id ?? `mock-${o.kind}`;
    this.url = `mock://${this.id}`;
    this.slots = o.slots ?? 4;
    this.dims = o.dimensions ?? 1024;
    this.latencyMs = o.latencyMs ?? 0;
    this.perItemMs = o.perItemMs ?? 0;
    this.fixtures = o.fixtures ?? new Map();
    this.failRate = o.failRate ?? 0;
    this.script = o.script;
    this.modelName = o.modelName ?? (o.kind === "embed" ? MOCK_EMBED_MODEL : o.kind === "rerank" ? MOCK_RERANK_MODEL : o.kind === "ocr" ? MOCK_OCR_MODEL : MOCK_CHAT_MODEL);
  }

  private async delay(items: number, signal?: AbortSignal): Promise<void> {
    this.calls++;
    const ms = this.latencyMs + this.perItemMs * items;
    if (ms > 0) await new Promise<void>((r, j) => {
      const t = setTimeout(r, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), j(signal.reason)), { once: true });
    });
    if (!this.up) throw new Error(`${this.id} is down`);
    if (this.failRate > 0 && Math.random() < this.failRate) throw new Error(`${this.id} random failure`);
  }

  async health(): Promise<boolean> {
    return this.up;
  }

  async identity(): Promise<ModelIdentity> {
    return this.kind === "embed" ? { model: this.modelName, dimensions: this.dims } : { model: this.modelName };
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    await this.delay(1, signal);
    if (this.script) {
      const r = this.script(req, this.turn++);
      return { content: r.content ?? "", toolCalls: r.toolCalls ?? [], finishReason: r.finishReason ?? (r.toolCalls?.length ? "tool_calls" : "stop"), usage: r.usage ?? { promptTokens: 0, completionTokens: 0 } };
    }
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const key = createHash("sha256").update(last).digest("hex");
    const content = this.fixtures.get(key) ?? `[mock] ${words(last).slice(0, 24).join(" ")}`;
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: Math.ceil(last.length / 4), completionTokens: Math.ceil(content.length / 4) },
    };
  }

  /** One line per page, with the image size: tests check order and grouping. */
  async ocr(req: OcrRequest, signal?: AbortSignal): Promise<OcrResponse> {
    await this.delay(req.images.length, signal);
    return {
      pages: req.images.map((img, i) => `Testo riconosciuto ${i + 1} di ${req.images.length} (${img.mime}, ${img.data.length} byte).`),
      model: this.modelName,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }

  async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
    await this.delay(req.texts.length, signal);
    return {
      vectors: req.texts.map((t) => mockEmbedding(t, this.dims)),
      model: this.modelName,
      tokens: req.texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
    };
  }

  async rerank(req: RerankRequest, signal?: AbortSignal): Promise<RerankResponse> {
    await this.delay(req.documents.length, signal);
    const q = new Set(words(req.query));
    const scores = req.documents.map((d) => {
      const ws = words(d);
      if (ws.length === 0 || q.size === 0) return 0;
      let hit = 0;
      for (const w of ws) if (q.has(w)) hit++;
      return hit / Math.sqrt(ws.length * q.size);
    });
    return { scores, model: this.modelName };
  }
}
