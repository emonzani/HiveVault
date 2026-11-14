import path from "node:path";
import { createLogger, type ModelsConfig } from "@cb/shared";
import { ModelDispatcher } from "./dispatcher.ts";
import { LlamaEndpoint } from "./llama.ts";
import { MockEndpoint } from "./mock.ts";
import { LocalModelSupervisor } from "./supervisor.ts";

export * from "./types.ts";
export * from "./dispatcher.ts";
export * from "./llama.ts";
export * from "./mock.ts";
export * from "./supervisor.ts";

export interface ModelsRuntime {
  dispatcher: ModelDispatcher;
  supervisors: LocalModelSupervisor[];
  stop(): Promise<void>;
}

const log = createLogger("models");

/** Pool of the small chat models for extraction and short structured answers (M4). */
export const EXTRACT_POOL = "extract";

/**
 * Builds the dispatcher from the configuration (plan §2.4):
 * chat endpoint, local supervised processes, remote endpoints,
 * and mock fallbacks for development.
 */
export function createModelsRuntime(cfg: ModelsConfig): ModelsRuntime {
  const dispatcher = new ModelDispatcher({
    expected: {
      embed: { model: cfg.embed.modelId, dimensions: cfg.embed.dimensions },
      rerank: { model: cfg.rerank.modelId },
    },
    agingMs: cfg.chat.agingMs,
    offlineMode: cfg.offlineMode,
  }).start();

  const add = (ep: LlamaEndpoint | MockEndpoint, fallback = false, pool?: string) =>
    void dispatcher.addEndpoint(ep, { fallback, ...(pool ? { pool } : {}) }).catch((e) => log.error("add endpoint", { id: ep.id, error: String(e) }));

  if (cfg.chat.url) {
    add(
      new LlamaEndpoint({
        id: "chat",
        kind: "chat",
        origin: "remote",
        url: cfg.chat.url,
        slots: cfg.chat.parallelism,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.chat.requestTimeoutMs,
        maxTokens: cfg.chat.maxTokens,
        temperature: cfg.chat.temperature,
      }),
    );
  }

  // small chat models for extraction (M4): they serve only the jobs of the pool "extract"
  cfg.chat.extractUrls.forEach((url, i) =>
    add(
      new LlamaEndpoint({
        id: `remote-extract-${i + 1}`,
        kind: "chat",
        origin: "remote",
        url,
        slots: cfg.chat.extractParallelism,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.chat.requestTimeoutMs,
        maxTokens: cfg.chat.maxTokens,
        temperature: cfg.chat.temperature,
      }),
      false,
      EXTRACT_POOL,
    ),
  );

  const supervisors: LocalModelSupervisor[] = [];
  if (cfg.local.enabled) {
    for (const kind of ["embed", "rerank"] as const) {
      const sup = new LocalModelSupervisor({
        name: `local-${kind}`,
        kind,
        bin: cfg.local.bin,
        model: path.join(cfg.local.modelsDir, kind === "embed" ? cfg.embed.modelId : cfg.rerank.modelId),
        port: kind === "embed" ? cfg.local.embedPort : cfg.local.rerankPort,
        threads: cfg.local.threads,
        schedule: cfg.local.schedule,
        offHours: cfg.local.offHours,
        extraArgs: cfg.local.extraArgs,
      });
      const ep = new LlamaEndpoint({ id: `local-${kind}`, kind, origin: "local", url: sup.url, slots: kind === "embed" ? 4 : 2 });
      add(ep);
      // When the process becomes healthy again, the dispatcher re-reads its identity.
      sup.on("status", (s) => {
        if (s === "running") void dispatcher.recheck(ep.id);
      });
      sup.start();
      supervisors.push(sup);
    }
  }

  cfg.embed.remoteUrls.forEach((url, i) =>
    add(new LlamaEndpoint({ id: `remote-embed-${i + 1}`, kind: "embed", origin: "remote", url, slots: 4, apiKey: cfg.apiKey })),
  );
  cfg.rerank.remoteUrls.forEach((url, i) =>
    add(new LlamaEndpoint({ id: `remote-rerank-${i + 1}`, kind: "rerank", origin: "remote", url, slots: 2, apiKey: cfg.apiKey })),
  );

  cfg.ocr.remoteUrls.forEach((url, i) =>
    add(new LlamaEndpoint({ id: `remote-ocr-${i + 1}`, kind: "ocr", origin: "remote", url, slots: 1, apiKey: cfg.apiKey, timeoutMs: cfg.chat.requestTimeoutMs, ocrPrompt: cfg.ocr.prompt })),
  );

  if (cfg.offlineMode === "mock") {
    add(new MockEndpoint({ kind: "chat", id: "mock-chat" }), true);
    add(new MockEndpoint({ kind: "embed", id: "mock-embed", dimensions: cfg.embed.dimensions }), true);
    add(new MockEndpoint({ kind: "rerank", id: "mock-rerank" }), true);
  }

  return {
    dispatcher,
    supervisors,
    async stop() {
      dispatcher.stop();
      await Promise.all(supervisors.map((s) => s.stop()));
    },
  };
}
