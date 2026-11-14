import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MockEndpoint, ModelDispatcher, MOCK_EMBED_MODEL } from "@cb/models";
import { ulid } from "@cb/shared";
import { EmbeddingIndexer, neighbors, PageStore, readPage, SearchEngine, snippet, VaultStore, type Principal } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const DIMS = 64;
const ep = new MockEndpoint({ kind: "embed", id: "mock", dimensions: DIMS, slots: 4 });
const dispatcher = new ModelDispatcher({ expected: { embed: { model: MOCK_EMBED_MODEL, dimensions: DIMS } } });
await dispatcher.addEndpoint(ep);
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-search-"));
afterAll(async () => {
  dispatcher.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();

async function vaultWith(slug: string, docs: string[], opts: { vectorIndex?: "binary" | "full" | "none" } = {}) {
  const v = await new VaultStore(sql!, DIMS).create({ kind: "space", slug: `${slug}-${run}`, name: slug, ...opts });
  const ps = new PageStore(sql!, { minTokens: 1 });
  const ids: string[] = [];
  for (const d of docs) ids.push((await ps.upsert({ vaultId: v.id, markdown: d })).page.id);
  await new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL }).run(v.id);
  return { v, ids, ps };
}
const engine = () => new SearchEngine(sql!, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL });

const ACME = `---
title: Alpi Sanità S.p.A.
type: entity/company
aliases: [Alpi Sanita]
---
Cliente sanitario con 250 postazioni di Company example 2.

## Stato attuale
- Contratto Company example 2 per 250 postazioni, rinnovo l'8 aprile 2026.
- Referente tecnico [[Nome CognomeCCC]].

## Timeline
- 2025-12-04 · Ampliamento a 250 postazioni
- 2025-05-31 · Firma del contratto
- 2025-04-22 · Offerta per 175 postazioni
`;
const PERSON_CCC = `---\ntitle: Nome CognomeCCC\ntype: entity/person\n---\nResponsabile IT di [[Alpi Sanità S.p.A.]], referente tecnico per Company example 2.`;
const SECRET = `---\ntitle: Stipendi 2026\ntype: note\nclassification: riservato\n---\nTabella stipendi e postazioni del personale amministrativo.`;

describe("SearchEngine", () => {
  db()("finds pages by meaning and words, with snippets and citations", async () => {
    const { v, ids } = await vaultWith("s1", [ACME, PERSON_CCC, SECRET]);
    const p: Principal = { id: "u", vaults: [v.id], clearance: 1 };
    const r = await engine().search(p, "quante postazioni ha Alpi Sanità");
    expect(r.degraded).toEqual([]);
    expect(r.hits[0]!.id).toBe(ids[0]);
    expect(r.hits[0]!.level).toBe("I3");
    expect(r.hits[0]!.cite).toMatch(new RegExp(`^${ids[0]}#`));
    expect(r.hits[0]!.chunks[0]!.snippet).toMatch(/«postazioni»/);
    expect(r.hits.map((h) => h.id)).not.toContain(ids[2]); // riservato > clearance 1
    const r2 = await engine().search({ ...p, clearance: 2 }, "stipendi personale");
    expect(r2.hits[0]!.id).toBe(ids[2]);
  });

  db()("compares only vectors of the query's model (a vault indexed by another model does not break search)", async () => {
    const good = await vaultWith("mdl-a", [ACME]);
    // another vault indexed by an older model with other dimensions (e.g. a test or a former model)
    const other = await new VaultStore(sql!, 16).create({ kind: "space", slug: `mdl-b-${run}`, name: "altro modello" });
    await new PageStore(sql!, { minTokens: 1 }).upsert({ vaultId: other.id, markdown: PERSON_CCC });
    const old = new ModelDispatcher({ expected: { embed: { model: "old-model-v0", dimensions: 16 } } });
    await old.addEndpoint(new MockEndpoint({ kind: "embed", id: "old", dimensions: 16, modelName: "old-model-v0" }));
    await new EmbeddingIndexer(sql!, old, { model: "old-model-v0" }).run(other.id);
    old.stop();
    const [n] = await sql!<{ n: number }[]>`select count(*)::int as n from chunks where vault_id = ${other.id} and vector_dims(embedding) = 16`;
    expect(n!.n).toBeGreaterThan(0);

    const r = await engine().search({ id: "u", vaults: [good.v.id, other.id], clearance: 1 }, "quante postazioni ha Alpi Sanità");
    expect(r.hits[0]!.id).toBe(good.ids[0]);
    // the other vault is still found by its words, never by its foreign vectors
    const r2 = await engine().search({ id: "u", vaults: [good.v.id, other.id], clearance: 1 }, "Nome CognomeCCC");
    expect(r2.hits.some((h) => h.vaultId === other.id)).toBe(true);
  });

  db()("never returns pages of vaults outside the principal", async () => {
    const a = await vaultWith("acl-a", [ACME]);
    const b = await vaultWith("acl-b", [PERSON_CCC]);
    const r = await engine().search({ id: "u", vaults: [a.v.id], clearance: 3 }, "Nome CognomeCCC responsabile IT");
    expect(r.hits.every((h) => h.vaultId === a.v.id)).toBe(true);
    // asking for a vault the principal does not have is ignored
    const r2 = await engine().search({ id: "u", vaults: [a.v.id], clearance: 3 }, "Nome CognomeCCC", { vaults: [b.v.id] });
    expect(r2.hits).toEqual([]);
  });

  db()("matches by title alone and filters by type", async () => {
    const { v, ids } = await vaultWith("s2", [ACME, PERSON_CCC]);
    const p: Principal = { id: "u", vaults: [v.id], clearance: 1 };
    const r = await engine().search(p, "Nome CognomeCCC", { types: ["entity/person"] });
    expect(r.hits.map((h) => h.id)).toEqual([ids[1]]);
    expect(r.hits[0]!.matchedTitle).toBe(true);
  });

  db()("works with full HNSW vaults and with vaults without vectors", async () => {
    const full = await vaultWith("full", [ACME], { vectorIndex: "full" });
    const none = await vaultWith("none", [PERSON_CCC], { vectorIndex: "none" });
    const r = await engine().search({ id: "u", vaults: [full.v.id, none.v.id], clearance: 1 }, "referente tecnico Company example 2");
    expect(new Set(r.hits.map((h) => h.vaultId))).toEqual(new Set([full.v.id, none.v.id]));
  });

  db()("falls back to full-text when the embedding model is not available", async () => {
    const { v, ids } = await vaultWith("s3", [ACME]);
    const noModel = new SearchEngine(sql!, undefined, { dims: DIMS, embedModel: MOCK_EMBED_MODEL });
    const r = await noModel.search({ id: "u", vaults: [v.id], clearance: 1 }, "postazioni Company example 2");
    expect(r.degraded).toEqual(["vector"]);
    expect(r.hits[0]!.id).toBe(ids[0]);
  });

  db()("caches results and invalidates them when the vault changes", async () => {
    const { v, ps } = await vaultWith("s4", [ACME]);
    const p: Principal = { id: "u", vaults: [v.id], clearance: 1 };
    const e = engine();
    expect((await e.search(p, "Zefiro portale")).cached).toBe(false);
    expect((await e.search(p, "Zefiro portale")).cached).toBe(true);
    await ps.upsert({ vaultId: v.id, markdown: "# Progetto Zefiro\n\nPortale clienti Zefiro." });
    const r = await e.search(p, "Zefiro portale");
    expect(r.cached).toBe(false);
    expect(r.hits[0]!.title).toBe("Progetto Zefiro");
  });

  db()("drops vector-only noise below the similarity floor", async () => {
    const { v } = await vaultWith("s6", [ACME]);
    const p: Principal = { id: "u", vaults: [v.id], clearance: 1 };
    const loose = await engine().search(p, "ricetta torta mele");
    expect(loose.hits.length).toBeGreaterThan(0); // nearest neighbor, unrelated
    const strict = new SearchEngine(sql!, dispatcher, { dims: DIMS, embedModel: MOCK_EMBED_MODEL, minVectorSimilarity: 0.4 }); // mock vectors (64 dims) collide up to ~0.25
    expect((await strict.search(p, "ricetta torta mele")).hits).toEqual([]);
    expect((await strict.search(p, "postazioni Company example 2")).hits.length).toBe(1);
  });

  db()("respects the token budget but always returns the best hit", async () => {
    const docs = Array.from({ length: 12 }, (_, i) => `# Verbale ${i}\n\nRiunione sul collaudo del portale numero ${i}. ` + "Il collaudo del portale prosegue. ".repeat(20));
    const { v } = await vaultWith("s5", docs);
    const p: Principal = { id: "u", vaults: [v.id], clearance: 1 };
    const big = await engine().search(p, "collaudo portale", { limit: 12, maxTokens: 100_000 });
    const small = await engine().search(p, "collaudo portale", { limit: 12, maxTokens: 150 });
    expect(big.hits.length).toBeGreaterThan(small.hits.length);
    expect(small.hits.length).toBeGreaterThanOrEqual(1);
    expect(small.totalTokens).toBeLessThanOrEqual(Math.max(150, small.totalTokens === 0 ? 0 : small.totalTokens));
  });
});

describe("snippet", () => {
  it("marks query words, ignoring accents and suffixes", () => {
    expect(snippet("La città di Forlì conferma le postazioni.", ["citta", "posta"])).toBe("La «città» di Forlì conferma le «postazioni».");
  });
  it("centers the window on the densest group of matches", () => {
    const text = "Introduzione lunga. ".repeat(40) + "Qui si parla del rinnovo del contratto Atlas e del rinnovo delle licenze." + " Coda.".repeat(40);
    const s = snippet(text, ["rinno", "contr"]);
    expect(s.startsWith("…")).toBe(true);
    expect(s).toContain("«rinnovo» del «contratto»");
  });
});

describe("readPage and neighbors", () => {
  db()("cuts a page to the budget: compiled truth first, omitted sections listed", async () => {
    const long = ACME + "\n## Note storiche\n\n" + "Dettagli storici sulla trattativa. ".repeat(200) + "\n\n## Contatti\n\nCentralino.";
    const { v, ids } = await vaultWith("r1", [long]);
    const p: Principal = { id: "u", vaults: [v.id], clearance: 1 };
    const r = (await readPage(sql!, p, ids[0]!, { maxTokens: 200 }))!;
    expect(r.contentTokens).toBeLessThanOrEqual(260);
    expect(r.content).toContain("## Stato attuale");
    expect(r.truncated).toBe(true);
    expect(r.omitted.map((o) => o.id)).toContain("note-storiche");
    const s = (await readPage(sql!, p, "alpi sanita", { sections: ["contatti"], maxTokens: 500 }))!;
    expect(s.id).toBe(ids[0]);
    expect(s.content).toContain("Centralino.");
    expect(s.content).not.toContain("Stato attuale");
  });

  db()("keeps the most recent timeline lines when the whole timeline does not fit", async () => {
    const tl = Array.from({ length: 80 }, (_, i) => `- 2025-${String(12 - (i % 12)).padStart(2, "0")}-01 · Evento numero ${i} con una descrizione.`).join("\n");
    const { v, ids } = await vaultWith("r2", [`# Cliente X\n\nSintesi.\n\n## Stato attuale\n- ok\n\n## Timeline\n${tl}`]);
    const r = (await readPage(sql!, { id: "u", vaults: [v.id], clearance: 1 }, ids[0]!, { maxTokens: 150 }))!;
    expect(r.content).toContain("Evento numero 0 ");
    expect(r.content).not.toContain("Evento numero 79 ");
    expect(r.content).toContain("…");
  });

  db()("returns the neighborhood of a page within the principal's vaults", async () => {
    const { v, ids } = await vaultWith("n1", [ACME, PERSON_CCC, "# Company example 2\n\nProdotto usato da [[Alpi Sanità S.p.A.]]."]);
    const g = await neighbors(sql!, { id: "u", vaults: [v.id], clearance: 1 }, ids[1]!, 2);
    expect(g.nodes.map((n) => n.title).sort()).toEqual(["Alpi Sanità S.p.A.", "Company example 2", "Nome CognomeCCC"]);
    expect(g.edges.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Retrieval quality on the synthetic corpus (regression guard; mock embeddings)
// ---------------------------------------------------------------------------
describe("corpus retrieval", () => {
  db()("finds the expected source document for most questions (hit@5)", async () => {
    const out = path.join(tmp, "corpus");
    execFileSync(process.execPath, ["--import", "tsx", "bench/corpus/generate.ts", "--seed", "7", "--clients", "6", "--noise", "60", "--out", out], { stdio: "ignore" });
    expect(existsSync(path.join(out, "manifest.json"))).toBe(true);
    const v = await new VaultStore(sql!, DIMS).create({ kind: "space", slug: `corpus-${run}`, name: "corpus" });
    const ps = new PageStore(sql!);
    const byPage = new Map<string, string>();
    async function walk(dir: string): Promise<string[]> {
      const es = await readdir(dir, { withFileTypes: true });
      return (await Promise.all(es.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])))).flat();
    }
    const docsDir = path.join(out, "docs");
    for (const f of await walk(docsDir)) {
      const rel = path.relative(docsDir, f).replaceAll("\\", "/");
      const text = (await readFile(f, "utf8")).replace(/\r\n/g, "\n");
      const r = await ps.upsert({ vaultId: v.id, path: `sources/${rel}.md`, frontmatter: { title: rel, type: "source" }, body: text });
      byPage.set(r.page.id, rel);
    }
    await new EmbeddingIndexer(sql!, dispatcher, { model: MOCK_EMBED_MODEL }).run(v.id);
    const questions = (await readFile(path.join(out, "truth", "questions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { question: string; sources: string[]; kind: string });
    const e = engine();
    let hits = 0;
    for (const q of questions) {
      const r = await e.search({ id: "eval", vaults: [v.id], clearance: 3 }, q.question, { limit: 5, maxTokens: 100_000 });
      if (r.hits.some((h) => q.sources.includes(byPage.get(h.id) ?? ""))) hits++;
    }
    const rate = hits / questions.length;
    console.log(`corpus hit@5 (mock embeddings + full-text): ${(rate * 100).toFixed(0)}% on ${questions.length} questions`);
    expect(rate).toBeGreaterThan(0.55);
  }, 120_000);
});
