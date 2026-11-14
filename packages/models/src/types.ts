export type ModelKind = "chat" | "embed" | "rerank" | "ocr";

/** 0 = interactive (search, ask), 1 = ingestion, 2 = background (dream cycle, backfill). */
export type Priority = 0 | 1 | 2;

export type EndpointOrigin = "local" | "remote" | "mock";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /**
   * false: no reasoning before the answer (models with a thinking mode, e.g. Qwen3). For short
   * structured answers, where the reasoning would use the whole token budget.
   */
  thinking?: boolean;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  vectors: number[][];
  /** Identity of the model that produced the vectors: stored with every vector. */
  model: string;
  tokens: number;
}

export interface RerankRequest {
  query: string;
  documents: string[];
}

export interface RerankResponse {
  /** One score for each document, in input order. Higher is more relevant. */
  scores: number[];
  model: string;
}

export interface OcrRequest {
  /** Page images in page order. One request reads them together (tables across pages). */
  images: { data: Buffer; mime: string }[];
  maxTokens?: number;
}

export interface OcrResponse {
  /** Text of every page, in input order (Markdown). */
  pages: string[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface ModelIdentity {
  /** Normalized model name: file name without directory and extension, lower case. */
  model: string;
  /** Native vector size for embedding models. */
  dimensions?: number;
}

export interface Endpoint {
  readonly id: string;
  readonly kind: ModelKind;
  readonly origin: EndpointOrigin;
  readonly url: string;
  /** Requests the endpoint serves at the same time (llama-server slots). */
  readonly slots: number;
  health(signal?: AbortSignal): Promise<boolean>;
  identity(signal?: AbortSignal): Promise<ModelIdentity>;
  chat?(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  embed?(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse>;
  rerank?(req: RerankRequest, signal?: AbortSignal): Promise<RerankResponse>;
  ocr?(req: OcrRequest, signal?: AbortSignal): Promise<OcrResponse>;
}

/** "/models/Qwen3-Embedding-0.6B-Q8_0.gguf" -> "qwen3-embedding-0.6b-q8_0" */
export function normalizeModelName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.gguf$/i, "").trim().toLowerCase();
}

/** L2-normalize after Matryoshka truncation, so cosine = dot product. */
export function truncateAndNormalize(v: number[], dims: number): number[] {
  const out = v.length > dims ? v.slice(0, dims) : v.slice();
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}
