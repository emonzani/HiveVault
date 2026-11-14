import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  Endpoint,
  EndpointOrigin,
  ModelIdentity,
  ModelKind,
  OcrRequest,
  OcrResponse,
  RerankRequest,
  RerankResponse,
} from "./types.ts";
import { normalizeModelName } from "./types.ts";
import { Agent, fetch } from "undici";

export interface LlamaEndpointOptions {
  id: string;
  kind: ModelKind;
  origin: EndpointOrigin;
  url: string;
  slots?: number;
  apiKey?: string;
  timeoutMs?: number;
  /** Values for chat requests. */
  maxTokens?: number;
  temperature?: number;
  /**
   * Prompt of OCR requests. "generic": an instruction for any vision chat model
   * (llama-server with a multimodal projector). "unlimited-ocr": the fixed prompt of
   * Baidu Unlimited-OCR ("<PAGE><image>" per page + "Multi page parsing.").
   */
  ocrPrompt?: OcrPromptStyle;
}

export type OcrPromptStyle = "generic" | "unlimited-ocr";

const PAGE = "<PAGE>";

/**
 * The model output of a group of pages, cut at the "<PAGE>" markers. Special tokens and
 * grounding boxes of OCR models (<|ref|>, <|det|>[[x,y,...]]) are removed. A model that writes
 * fewer markers than pages gives empty pages at the end, more markers join the rest to the last.
 */
export function splitOcrPages(text: string, pages: number): string[] {
  const clean = text
    .replace(/<\|det\|>[\s\S]*?<\|\/det\|>/g, "")
    .replace(/<\|\/?[a-z_]+\|>/gi, "")
    .replace(/<\/?(?:s|eos|bos)>/gi, "");
  const parts = clean.split(PAGE).map((p) => p.trim());
  if (parts[0] === "") parts.shift();
  if (parts.length > pages) parts.splice(pages - 1, parts.length, parts.slice(pages - 1).join("\n\n"));
  while (parts.length < pages) parts.push("");
  return parts;
}

export class EndpointError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

/** An OpenAI-compatible llama.cpp llama-server. */
export class LlamaEndpoint implements Endpoint {
  readonly id: string;
  readonly kind: ModelKind;
  readonly origin: EndpointOrigin;
  readonly url: string;
  readonly slots: number;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly ocrPrompt: OcrPromptStyle;
  private cachedIdentity: ModelIdentity | undefined;
  /**
   * The HTTP client of this endpoint. The default client of fetch closes a request after
   * 300 s without headers: a non-streaming chat with a long prompt sends its headers only
   * at the end, so the limit is the timeout of the endpoint (the AbortSignal) instead.
   */
  private readonly agent: Agent;

  constructor(o: LlamaEndpointOptions) {
    this.id = o.id;
    this.kind = o.kind;
    this.origin = o.origin;
    this.url = o.url.replace(/\/+$/, "");
    this.slots = o.slots ?? 1;
    this.apiKey = o.apiKey || undefined;
    this.timeoutMs = o.timeoutMs ?? 120_000;
    this.maxTokens = o.maxTokens ?? 4096;
    this.temperature = o.temperature ?? 0.2;
    this.ocrPrompt = o.ocrPrompt ?? "generic";
    this.agent = new Agent({ headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs });
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown }, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(this.url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      dispatcher: this.agent,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EndpointError(`${this.id} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request<unknown>("/health", {}, signal, 3000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Model name from /v1/models (fallback /props). For embedding endpoints the native
   * vector size comes from a probe request: the only value that cannot lie.
   */
  async identity(signal?: AbortSignal): Promise<ModelIdentity> {
    if (this.cachedIdentity) return this.cachedIdentity;
    let model = "";
    try {
      const r = await this.request<{ data?: { id: string }[] }>("/v1/models", {}, signal, 5000);
      model = r.data?.[0]?.id ?? "";
    } catch {
      const p = await this.request<{ model_path?: string }>("/props", {}, signal, 5000);
      model = p.model_path ?? "";
    }
    const id: ModelIdentity = { model: normalizeModelName(model) };
    if (this.kind === "embed") {
      const probe = await this.rawEmbed(["identity probe"], signal);
      id.dimensions = probe[0]?.length;
    }
    this.cachedIdentity = id;
    return id;
  }

  /** Forget the cached identity (after a restart the model can be different). */
  resetIdentity(): void {
    this.cachedIdentity = undefined;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    type R = {
      choices: { message: { content: string | null; tool_calls?: ChatResponse["toolCalls"] }; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const r = await this.request<R>(
      "/v1/chat/completions",
      {
        body: {
          messages: req.messages,
          tools: req.tools,
          max_tokens: req.maxTokens ?? this.maxTokens,
          temperature: req.temperature ?? this.temperature,
          ...(req.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        },
      },
      signal,
    );
    const choice = r.choices[0];
    return {
      content: choice?.message.content ?? "",
      toolCalls: choice?.message.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? "unknown",
      usage: { promptTokens: r.usage?.prompt_tokens ?? 0, completionTokens: r.usage?.completion_tokens ?? 0 },
    };
  }

  async ocr(req: OcrRequest, signal?: AbortSignal): Promise<OcrResponse> {
    type R = { choices: { message: { content: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    const n = req.images.length;
    const images = req.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data.toString("base64")}` } }));
    const prompt =
      this.ocrPrompt === "unlimited-ocr"
        ? `${"<PAGE><image>".repeat(n)}Multi page parsing.`
        : `Trascrivi in Markdown tutto il testo ${n === 1 ? "di questa pagina" : `di queste ${n} pagine, nell'ordine`}. ` +
          `Comincia ogni pagina con una riga che contiene solo ${PAGE}. Mantieni titoli, elenchi e tabelle (tabelle Markdown). ` +
          "Scrivi il testo come appare, nella sua lingua: non tradurre, non riassumere, non aggiungere commenti.";
    const r = await this.request<R>(
      "/v1/chat/completions",
      {
        body: {
          messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
          max_tokens: req.maxTokens ?? 4000 * n,
          temperature: 0,
          ...(this.ocrPrompt === "unlimited-ocr" ? { skip_special_tokens: false } : { chat_template_kwargs: { enable_thinking: false } }),
        },
      },
      signal,
    );
    const id = await this.identity(signal);
    return {
      pages: splitOcrPages(r.choices[0]?.message.content ?? "", n),
      model: id.model,
      usage: { promptTokens: r.usage?.prompt_tokens ?? 0, completionTokens: r.usage?.completion_tokens ?? 0 },
    };
  }

  private async rawEmbed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    type R = { data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens: number } };
    const r = await this.request<R>("/v1/embeddings", { body: { input: texts } }, signal);
    return r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
    type R = { data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens: number } };
    const r = await this.request<R>("/v1/embeddings", { body: { input: req.texts } }, signal);
    const id = await this.identity(signal);
    return {
      vectors: r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
      model: id.model,
      tokens: r.usage?.prompt_tokens ?? 0,
    };
  }

  async rerank(req: RerankRequest, signal?: AbortSignal): Promise<RerankResponse> {
    type R = { results: { index: number; relevance_score: number }[] };
    const r = await this.request<R>("/v1/rerank", { body: { query: req.query, documents: req.documents } }, signal);
    const scores = new Array<number>(req.documents.length).fill(Number.NEGATIVE_INFINITY);
    for (const x of r.results) scores[x.index] = x.relevance_score;
    const id = await this.identity(signal);
    return { scores, model: id.model };
  }
}
