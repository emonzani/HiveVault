// The compiler on the database: duplicates at write time (M6), map of long documents (M8),
// new versions of a document (M9), compilation when the model is free (M3).
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "@cb/blobs";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MockEndpoint, ModelDispatcher, type ChatRequest } from "@cb/models";
import { metrics, ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { Compiler, defineIdleCompileTask, SourceStore, type Source } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();
let engine: TaskEngine | undefined;
afterAll(async () => {
  await engine?.stop();
  await sql?.end();
});

/** Scripted model: one company per part (the first "Ditta ..." of the text), one sentence per listed section. */
function scripted() {
  const parts: string[] = [];
  const chat = new MockEndpoint({
    kind: "chat",
    id: `json-${run}`,
    script: (req: ChatRequest) => {
      const user = String(req.messages.at(-1)?.content ?? "");
      const text = user.slice(user.indexOf("Testo:"));
      parts.push(text);
      const chunk = Number(/\[c(\d+)\]/.exec(text)?.[1] ?? 0);
      const company = /(Ditta [A-Z][a-z]+(?: [A-Z][a-z]+)*)/.exec(text)?.[1];
      const sections = [...user.matchAll(/^- \[c(\d+)\] (.+)$/gm)].map((m) => ({ chunk: Number(m[1]), text: `La sezione ${m[2]} descrive le condizioni.` }));
      const entities = company ? [{ title: company, type: "entity/company", tldr: "Fornitore citato nel documento.", facts: [{ label: "Citata in", value: `parte c${chunk}`, chunk }] }] : [];
      return { content: JSON.stringify({ entities, sections }), usage: { promptTokens: 100, completionTokens: 20 } };
    },
  });
  return { chat, parts };
}

async function setup(slug: string, readTokens = 3000) {
  const { chat, parts } = scripted();
  const dispatcher = new ModelDispatcher({ expected: {} });
  await dispatcher.addEndpoint(chat);
  const store = new SourceStore(sql!, new FsBlobStore(await mkdtemp(path.join(os.tmpdir(), "cb-versions-")), randomBytes(32)));
  const pages = new PageStore(sql!);
  const compiler = new Compiler(sql!, store, pages, new SearchEngine(sql!, undefined, { dims: 16, embedModel: "m" }), dispatcher, { useModel: "always", readTokens });
  const vault = await new VaultStore(sql!, 16).create({ kind: "cell", slug: `${slug}-${run}`, name: slug });
  const source = async (name: string, text: string, o: { path?: string } = {}): Promise<Source> => {
    const { source: s } = await store.create(Buffer.from(text), { vaultId: vault.id, name, origin: o.path ? "import" : "upload", ...(o.path ? { path: o.path } : {}) });
    await store.update(s.id, { status: "parsed", level: 1 });
    await store.writeChunks(s, text, "italian", { minTokens: 1, targetTokens: 40, maxTokens: 60 });
    return (await store.get(s.id))!;
  };
  return { compiler, pages, vault, source, parts, store };
}

const manual = (last: string) =>
  [
    "# Manuale",
    ...["Alfa", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"].map(
      (s, i) => `## ${s}\n\nLa sezione ${s} riguarda la fornitura di Ditta ${s} con ${i + 1} consegne mensili, il collaudo e le penali previste.${s === "Kappa" ? ` ${last}` : ""}`,
    ),
  ].join("\n\n");

describe("compiler: duplicates, map, versions", () => {
  db()("a new title that differs only in a generic word updates the existing page (M6)", async () => {
    const t = await setup("dup");
    const existing = await t.pages.upsert({
      vaultId: t.vault.id,
      markdown: `---\ntitle: Ditta Salentina Costruzioni S.r.l.\ntype: entity/company\n---\n# Ditta Salentina Costruzioni S.r.l.\n\nImpresa edile con sede a Lecce.\n`,
    });
    const s = await t.source("verbale.md", "# Verbale\n\nDitta Salentina Costruzioni Group chiede una proroga.");
    const r = await t.compiler.compile(s);
    expect(r.pages).toEqual([existing.page.id]);
    const page = (await PageStore.get(sql!, existing.page.id))!;
    expect(page.frontmatter.aliases).toContain("Ditta Salentina Costruzioni Group");
    expect(page.body).toContain(`- Citata in: parte c`);
    // M19: the compiler counts what it does, with bounded labels
    const prom = metrics.prometheus();
    expect(prom).toMatch(/compile_duplicates\S*\{[^}]*outcome="merged"[^}]*\} [1-9]/);
    expect(prom).toMatch(/compile_sources\S*\{[^}]*mode="extract"/);
    expect(prom).toContain("compile_pages");
  });

  db()("a long document gets a map of its sections; a new version sends only the changed parts (M8, M9)", { timeout: 60_000 }, async () => {
    const t = await setup("ver", 120);
    const v1 = await t.source("manuale.md", manual("Fine."), { path: "/import/manuale.md" });
    const r1 = await t.compiler.compile(v1);
    expect(r1.turns).toBeGreaterThan(2);
    expect(r1.skippedParts).toBe(0);
    const page1 = (await PageStore.get(sql!, r1.sourcePage))!;
    expect(page1.body).toContain("## Mappa");
    expect(page1.body).toMatch(/- \*\*Alfa\*\* \(c\d+(–c\d+)?\): La sezione Alfa descrive le condizioni\. \^\[/);
    const calls1 = t.parts.length;

    // version 2: only the last section changed
    const v2 = await t.source("manuale.md", manual("Aggiunta una clausola di recesso."), { path: "/import/manuale.md" });
    const r2 = await t.compiler.compile(v2);
    const calls2 = t.parts.length - calls1;
    expect(calls2).toBe(1);
    expect(r2.turns).toBe(1);
    expect(r2.skippedParts).toBe(r1.turns - 1);
    expect(t.parts.at(-1)).toContain("clausola di recesso");
    // the map is whole: unchanged sections reuse the sentences of version 1
    const page2 = (await PageStore.get(sql!, r2.sourcePage))!;
    for (const s of ["Alfa", "Epsilon", "Kappa"]) expect(page2.body).toContain(`**${s}**`);

    // another document with the same name but another path is not a version
    const other = await t.source("manuale.md", manual("Altro testo."), { path: "/import/altro/manuale.md" });
    expect((await t.compiler.compile(other)).skippedParts).toBe(0);
  });
});

describe("compilation when the model is free (M3)", () => {
  db()("queues the backlog one source at a time, only while the model is ready", { timeout: 60_000 }, async () => {
    const t = await setup("idle");
    const a = await t.source("a.md", "# A\n\nDitta Aurora fornisce cemento.");
    const b = await t.source("b.md", "# B\n\nDitta Borea fornisce acciaio.");
    await sql!`update sources set demand = 5 where id = ${b.id}`;
    let ready = false;
    const queued: string[] = [];
    // compileNow stand-in: marks the source and compiles it at once
    const compileNow = async (id: string) => {
      queued.push(id);
      await t.store.update(id, { compile: true });
      await t.compiler.compile((await t.store.get(id))!);
      return id;
    };
    const task = defineIdleCompileTask({ sql: sql!, compileNow, ready: () => ready, intervalMs: 50, name: `idle-${run}`, vaultIds: [t.vault.id] });
    engine = new TaskEngine(sql!, { pollMs: 25 }).register(task);
    await engine.start();
    await engine.submit(task, {}, { requestId: `idle-${run}` });
    await new Promise((r) => setTimeout(r, 300));
    expect(queued).toEqual([]);
    ready = true;
    const compiled = async () => (await sql!<{ n: number }[]>`select count(*)::int as n from sources where id = any(${[a.id, b.id]}) and level = 3`)[0]!.n;
    for (let i = 0; i < 200 && (await compiled()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await compiled()).toBe(2);
    // the most searched first
    expect(queued).toEqual([b.id, a.id]);
  });
});
