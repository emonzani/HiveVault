// Shared wiring of the phase 3 acceptance runs: the same services in the runner and in the
// worker processes (blob store, parser in-thread, mock embeddings, scripted slow "model").
import "../../packages/db/src/env.ts";
import path from "node:path";
import { FsBlobStore, loadMasterKey } from "@cb/blobs";
import { EmbeddingIndexer, PageStore, SearchEngine } from "@cb/brain";
import { createDb } from "@cb/db";
import { Compiler, defineImportTask, defineIngestTask, SourceStore } from "@cb/ingest";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL, type ChatRequest } from "@cb/models";
import { parseFile } from "@cb/parsers";

export const DIMS = 16;
export const DATA = path.resolve("data/bench-phase3");

export function services(o: { max?: number; chatDelayMs?: number; importRoot?: string } = {}) {
  const sql = createDb({ max: o.max ?? 12, application: "bench-phase3", synchronousCommit: process.env.CB_SYNC_COMMIT !== "off" });
  const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
  void dispatcher.addEndpoint(new MockEndpoint({ kind: "embed", dimensions: DIMS, slots: 8 }));
  // Scripted model: reads the source, writes the source's own entity page and updates one
  // page shared by every source. Slow on purpose, so kills land inside the agent loop.
  void dispatcher.addEndpoint(
    new MockEndpoint({
      kind: "chat",
      id: "scripted",
      slots: 8,
      latencyMs: o.chatDelayMs ?? 150,
      script: (req: ChatRequest) => {
        const srcId = /Nuova sorgente (src_\w+)/.exec(req.messages[1]!.content)![1]!;
        const done = req.messages.filter((m) => m.role === "tool").length;
        const call = (name: string, args: unknown) => ({ toolCalls: [{ id: `t${done}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
        if (done === 0) return call("source_read", { part: 0 });
        if (done === 1) return call("wiki_write", { markdown: `---\ntitle: Entità ${srcId}\ntype: entity/project\n---\n## Stato attuale\n- Citata dalla sorgente ^[${srcId}#c0]` });
        if (done === 2) return call("wiki_write", { markdown: `---\ntitle: Cliente comune\ntype: entity/company\n---\n## Stato attuale\n- Ultimo aggiornamento da ^[${srcId}#c0]` });
        return { content: "FINE" };
      },
    }),
  );
  const store = new SourceStore(sql, new FsBlobStore(path.join(DATA, "blobs"), loadMasterKey("data")));
  const search = new SearchEngine(sql, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL });
  const compiler = new Compiler(sql, store, new PageStore(sql), search, dispatcher, { useModel: "always" });
  const ingestTask = defineIngestTask({
    store,
    parse: (d, n) => parseFile(d, n),
    indexer: () => new EmbeddingIndexer(sql, dispatcher, { model: MOCK_EMBED_MODEL }),
    compiler,
    chunk: { minTokens: 1 },
    name: "bench-ingest",
  });
  const importTask = defineImportTask({ sql, store, ingestTask, roots: o.importRoot ? [o.importRoot] : [], batch: 500, name: "bench-import" });
  return { sql, dispatcher, store, ingestTask, importTask };
}
