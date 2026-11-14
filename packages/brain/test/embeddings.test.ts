import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL } from "@cb/models";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { defineEmbedVaultTask, EmbeddingIndexer, PageStore, VaultStore } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const ep = new MockEndpoint({ kind: "embed", id: "mock", dimensions: 16, slots: 4 });
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: 16 } } });
await dispatcher.addEndpoint(ep);
const engines: TaskEngine[] = [];
afterAll(async () => {
  dispatcher.stop();
  await Promise.all(engines.map((e) => e.stop()));
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();

describe("EmbeddingIndexer", () => {
  db()("embeds pending chunks, reuses identical text and records the model", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "space", slug: `emb-${run}`, name: "emb" });
    const ps = new PageStore(sql!, { minTokens: 1 });
    const shared = `Testo identico ripetuto in due pagine diverse, esecuzione ${run}.`;
    await ps.upsert({ vaultId: v.id, markdown: `# Uno\n\n${shared}\n\n## Altro\n\nSolo nella prima ${run}.` });
    await ps.upsert({ vaultId: v.id, markdown: `# Due\n\n${shared}` });
    const indexer = new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL, batch: 1 });
    const before = ep.calls;
    const r = await indexer.run(v.id);
    expect(r.remaining).toBe(0);
    expect(r.embedded + r.reused).toBe(3);
    expect(r.reused).toBe(1); // the second copy of `shared`
    expect(ep.calls - before).toBe(2);
    const rows = await sql!<{ m: string; dims: number }[]>`
      select distinct embedding_model as m, vector_dims(embedding) as dims from chunks where vault_id = ${v.id}`;
    expect(rows).toEqual([{ m: MOCK_EMBED_MODEL, dims: 16 }]);
  });

  db()("runs as a durable task in rounds", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "space", slug: `embt-${run}`, name: "embt" });
    const ps = new PageStore(sql!, { minTokens: 1, targetTokens: 20, maxTokens: 40 });
    for (let i = 0; i < 5; i++) {
      await ps.upsert({ vaultId: v.id, markdown: `# Pagina ${i}\n\n${Array.from({ length: 6 }, (_, k) => `Paragrafo ${k} della pagina ${i} con parole diverse ${i * 7 + k}.`).join("\n\n")}` });
    }
    const Task = defineEmbedVaultTask(() => new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL, batch: 4 }), 5);
    const engine = new TaskEngine(sql!, { pollMs: 50 }).register(Task);
    engines.push(engine);
    await engine.start();
    const { id } = await engine.submit(Task, { vaultId: v.id }, { requestId: `embed:${v.id}` });
    const t = await engine.waitFor(id, 20_000);
    expect(t.status).toBe("done");
    const [{ n }] = (await sql!`select count(*)::int as n from chunks where vault_id = ${v.id} and embedding is null`) as unknown as [{ n: number }];
    expect(n).toBe(0);
    const rounds = await sql!`select count(*)::int as n from task_events where task_id = ${id} and kind = 'phase_done'`;
    expect((rounds[0] as { n: number }).n).toBeGreaterThan(1);
  });
});
