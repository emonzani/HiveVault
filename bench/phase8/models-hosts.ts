/**
 * Embedding and rerank hosts compared through the dispatcher (invariant 2): identity check,
 * test call, throughput of embeddings (batches of 32 texts) and latency of a rerank of 20
 * candidates (the default of brain_search). One endpoint at a time, so each number is its own.
 *
 * Usage: npx tsx bench/phase8/models-hosts.ts
 * Hosts: the remote URLs of .env (REMOTE_EMBED_URLS, REMOTE_RERANK_URLS, key MODELS_API_KEY) and
 * the local processes of the running server (LOCAL_EMBED_PORT, LOCAL_RERANK_PORT), if they answer.
 */
import "../../packages/db/src/env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { LlamaEndpoint, ModelDispatcher, type Endpoint } from "@cb/models";
import { loadModelsConfig } from "@cb/shared";

const cfg = loadModelsConfig();
const key = cfg.apiKey || undefined;
type Host = { id: string; kind: "embed" | "rerank"; url: string; apiKey?: string };
const hosts: Host[] = [
  ...cfg.embed.remoteUrls.map((url, i) => ({ id: `remoto-embed-${i + 1}`, kind: "embed" as const, url, ...(key ? { apiKey: key } : {}) })),
  ...cfg.rerank.remoteUrls.map((url, i) => ({ id: `remoto-rerank-${i + 1}`, kind: "rerank" as const, url, ...(key ? { apiKey: key } : {}) })),
  { id: "locale-embed", kind: "embed", url: `http://127.0.0.1:${cfg.local.embedPort}` },
  { id: "locale-rerank", kind: "rerank", url: `http://127.0.0.1:${cfg.local.rerankPort}` },
];

// realistic chunk texts: 300–500 tokens of Italian business prose
const words = "contratto fornitore cliente postazioni rinnovo progetto migrazione dati responsabile tecnico riunione budget decisione sede legale offerta preventivo consegna manutenzione licenza server rete sicurezza backup".split(" ");
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const text = (n: number) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ") + ".";
const chunks = Array.from({ length: 256 }, () => text(280 + Math.floor(rnd() * 120)));
// what the search sends to the reranker: the title and the snippet of each candidate
const docs = Array.from({ length: 20 }, () => `${text(4)}\n${text(40)}`);

const report: Record<string, unknown>[] = [];
for (const h of hosts) {
  const d = new ModelDispatcher({
    expected: { embed: { model: cfg.embed.modelId, dimensions: cfg.embed.dimensions }, rerank: { model: cfg.rerank.modelId } },
  });
  const ep: Endpoint = new LlamaEndpoint({ id: h.id, kind: h.kind, origin: h.id.startsWith("locale") ? "local" : "remote", url: h.url, slots: h.kind === "embed" ? 4 : 2, ...(h.apiKey ? { apiKey: h.apiKey } : {}) });
  const status = await d.addEndpoint(ep).catch((e: Error) => `errore: ${e.message}`);
  const t = await d.testEndpoint(h.id, 120_000);
  const row: Record<string, unknown> = { host: h.id, url: h.url, status, test: t.ok ? `ok (${t.ms} ms)` : `no: ${t.error}`, model: t.model };
  if (t.ok && status === "up") try {
    if (h.kind === "embed") {
      const t0 = performance.now();
      // 8 batches of 32 in parallel, like the indexer
      const batches = Array.from({ length: 8 }, (_, i) => chunks.slice(i * 32, i * 32 + 32));
      const out = await Promise.all(batches.map((b) => d.embed(b, { priority: 1, signal: AbortSignal.timeout(600_000) })));
      const s = (performance.now() - t0) / 1000;
      row.dims = out[0]!.vectors[0]!.length;
      row["chunk/s"] = Math.round(chunks.length / s);
      row.secondi = +s.toFixed(1);
    } else {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await d.rerank("quante postazioni ha il cliente e quando scade il contratto", docs, { priority: 0, signal: AbortSignal.timeout(60_000) });
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      row["rerank 20 (mediana ms)"] = Math.round(times[2]!);
    }
  } catch (e) {
    row.errore = (e as Error).message.slice(0, 160);
  }
  d.stop();
  report.push(row);
}
console.table(report);
mkdirSync("bench/out", { recursive: true });
writeFileSync("bench/out/phase8-models-hosts.json", JSON.stringify(report, null, 2));
