// Structured extraction (M2): the model answers with JSON, the code merges it into the pages.
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "@cb/blobs";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { extractClaims } from "@cb/hive";
import { MockEndpoint, ModelDispatcher, type ChatRequest } from "@cb/models";
import { ulid } from "@cb/shared";
import { Compiler, SourceStore } from "../src/index.ts";
import { mergeEntities, mergePage, parseExtraction, type ExtractedEntity } from "../src/extract.ts";

const entity = (o: Partial<ExtractedEntity> = {}): ExtractedEntity => ({
  title: "Tirrena Assicurazioni Group",
  type: "entity/company",
  aliases: [],
  tldr: "Cliente assicurativo con contratto di licenza Orbit Analytics.",
  facts: [],
  events: [],
  ...o,
});

describe("parseExtraction", () => {
  it("keeps entities with facts on known chunks and drops the rest", () => {
    const text = `<think>x</think>\`\`\`json
{"entities": [
  {"title": "Tirrena Assicurazioni Group", "type": "entity/company", "aliases": ["Tirrena"], "tldr": "Cliente.",
   "facts": [{"label": "Postazioni", "value": "975", "chunk": 2}, {"label": "Inventato", "value": "x", "chunk": 99}, {"label": "Vuoto", "value": "", "chunk": 2}],
   "events": [{"date": "2025-08-08", "text": "Ordine di 975 postazioni", "chunk": "c2"}, {"date": "agosto", "text": "senza data", "chunk": 2}]},
  {"title": "Senza fatti", "type": "concept", "facts": []},
  {"title": "Tipo strano", "type": "pianeta", "facts": [{"label": "Nota", "value": "y", "chunk": 1}]}
]}
\`\`\``;
    const out = parseExtraction(text, new Set([1, 2]))!;
    expect(out.map((e) => e.title)).toEqual(["Tirrena Assicurazioni Group", "Tipo strano"]);
    expect(out[0]!.facts).toEqual([{ label: "Postazioni", value: "975", chunk: 2 }]);
    expect(out[0]!.events).toEqual([{ date: "2025-08-08", text: "Ordine di 975 postazioni", chunk: 2 }]);
    expect(out[1]!.type).toBe("concept");
  });

  it("returns null when the answer is not JSON", () => {
    expect(parseExtraction("Non so.", new Set([0]))).toBeNull();
    expect(parseExtraction('{"entities": "no"}', new Set([0]))).toBeNull();
  });

  it("one entity named in two parts is one entity", () => {
    const a = entity({ facts: [{ label: "Postazioni", value: "975", chunk: 0 }] });
    const b = entity({ title: "Tirrena", aliases: ["Tirrena Assicurazioni Group"], facts: [{ label: "Database", value: "Oracle", chunk: 3 }] });
    const m = mergeEntities([[a], [b]]);
    expect(m).toHaveLength(1);
    expect(m[0]!.facts.map((f) => f.label)).toEqual(["Postazioni", "Database"]);
    expect(m[0]!.aliases).toContain("Tirrena");
  });
});

describe("mergePage", () => {
  const base = { sourceId: "src_new", citedDates: new Map([["src_old", "2025-02-17"]]), linkable: new Map([["vittoria serra", "Vittoria Serra"]]) };

  it("writes a new page in the format of the claims", () => {
    const m = mergePage({
      ...base,
      existing: null,
      sourceDate: "2025-02-17",
      entity: entity({ facts: [{ label: "Referente tecnico", value: "Vittoria Serra", chunk: 0 }, { label: "Postazioni", value: "800", chunk: 1 }], events: [{ date: "2025-02-17", text: "Kickoff", chunk: 0 }] }),
    });
    expect(m.frontmatter).toMatchObject({ title: "Tirrena Assicurazioni Group", type: "entity/company", tldr: expect.any(String) });
    expect(m.body).toContain("## Stato attuale\n\n- Referente tecnico: [[Vittoria Serra]] ^[src_new#c0]\n- Postazioni: 800 ^[src_new#c1]");
    expect(m.body).toContain("## Timeline\n\n- 2025-02-17 · Kickoff ^[src_new#c0]");
    expect(extractClaims(m.body).map((c) => [c.predicate, c.value])).toEqual([["referente tecnico", "[[Vittoria Serra]]"], ["postazioni", "800"]]);
  });

  const existing = {
    frontmatter: { title: "Tirrena Assicurazioni Group", type: "entity/company", tldr: "Cliente." },
    body: "# Tirrena Assicurazioni Group\n\nTesto scritto a mano.\n\n## Stato attuale\n\n- Postazioni: 800 ^[src_old#c1]\n- Nota libera senza etichetta\n\n## Note\n\nAltro testo.\n",
  };

  it("a newer document changes the value and moves the old one to the timeline", () => {
    const m = mergePage({ ...base, existing, sourceDate: "2025-08-08", entity: entity({ facts: [{ label: "Numero di postazioni", value: "975", chunk: 2 }] }) });
    expect(m.updated).toBe(1);
    expect(m.body).toContain("- Numero di postazioni: 975 ^[src_new#c2]");
    expect(m.body).not.toContain("- Postazioni: 800");
    expect(m.body).toContain("## Timeline\n\n- 2025-08-08 · Postazioni: 800 → 975 ^[src_new#c2]");
    // what people wrote stays
    expect(m.body).toContain("Testo scritto a mano.");
    expect(m.body).toContain("- Nota libera senza etichetta");
    expect(m.body).toContain("## Note\n\nAltro testo.");
  });

  it("an older document only adds a timeline event", () => {
    const m = mergePage({ ...base, existing, sourceDate: "2024-12-01", entity: entity({ facts: [{ label: "Postazioni", value: "600", chunk: 0 }] }) });
    expect(m.body).toContain("- Postazioni: 800 ^[src_old#c1]");
    expect(m.body).toContain("- 2024-12-01 · Postazioni: 600 ^[src_new#c0]");
  });

  it("without dates both values stay in a conflict block", () => {
    const m = mergePage({ ...base, existing, sourceDate: null, entity: entity({ facts: [{ label: "Postazioni", value: "600", chunk: 0 }, { label: "Database", value: "Oracle", chunk: 0 }] }) });
    expect(m.conflicts).toBe(1);
    // new facts go with the other bullets, before the conflict blocks
    expect(m.body).toContain("- Nota libera senza etichetta\n- Database: Oracle ^[src_new#c0]\n\n> [!conflict]");
    expect(m.body).toContain("> [!conflict] Postazioni\n> - 800 ^[src_old#c1]\n> - 600 ^[src_new#c0]");
    // the conflict block gives no claim: the current value stays the only one
    expect(extractClaims(m.body).filter((c) => c.predicate === "postazioni").map((c) => c.value)).toEqual(["800"]);
  });

  it("the same value only adds its citation; a merge twice changes nothing", () => {
    const input = { ...base, existing, sourceDate: "2025-08-08", entity: entity({ facts: [{ label: "Postazioni", value: "800", chunk: 4 }], events: [{ date: "2025-08-08", text: "Rinnovo", chunk: 4 }] }) };
    const once = mergePage(input);
    expect(once.body).toContain("- Postazioni: 800 ^[src_old#c1] ^[src_new#c4]");
    const twice = mergePage({ ...input, existing: { frontmatter: once.frontmatter, body: once.body } });
    expect(twice.body).toBe(once.body);
  });
});

// ---------------------------------------------------------------------------
// The compiler in extract mode, on the database
// ---------------------------------------------------------------------------

const sql: Sql | undefined = await setupTestDb();
const db = () => (sql ? it : it.skip);
const run = ulid().slice(-6).toLowerCase();
afterAll(async () => {
  await sql?.end();
});

describe("compiler, extract mode", () => {
  db()("two sources update one page: the newer value wins, the older goes to the timeline", async () => {
    const company = `Delta ${run} S.p.A.`;
    // scripted model: the number of seats is the last number of the text
    let calls = 0;
    const chat = new MockEndpoint({
      kind: "chat",
      id: "json",
      script: (req: ChatRequest) => {
        calls++;
        const user = String(req.messages.at(-1)?.content ?? "");
        const seats = [...user.matchAll(/(\d+) postazioni/g)].at(-1)?.[1];
        const chunk = /\[c(\d+)\]/.exec(user)?.[1];
        return {
          content: JSON.stringify({ entities: [{ title: company, type: "entity/company", tldr: "Cliente con un contratto di licenza.", facts: [{ label: "Postazioni", value: seats, chunk: Number(chunk) }] }] }),
          usage: { promptTokens: 300, completionTokens: 60 },
        };
      },
    });
    const dispatcher = new ModelDispatcher({ expected: {} });
    await dispatcher.addEndpoint(chat);
    const store = new SourceStore(sql!, new FsBlobStore(await mkdtemp(path.join(os.tmpdir(), "cb-extract-")), randomBytes(32)));
    const pages = new PageStore(sql!);
    const compiler = new Compiler(sql!, store, pages, new SearchEngine(sql!, undefined, { dims: 16, embedModel: "m" }), dispatcher, { useModel: "always" });
    const vault = await new VaultStore(sql!, 16).create({ kind: "cell", slug: `ex-${run}`, name: "Estrazione" });

    const source = async (name: string, date: string, text: string) => {
      const { source: s } = await store.create(Buffer.from(text), { vaultId: vault.id, name, origin: "upload" }, "system");
      await store.update(s.id, { status: "parsed", level: 1 }, { date });
      await store.writeChunks(s, text, "italian", { minTokens: 1 });
      return (await store.get(s.id))!;
    };
    const first = await source("ordine.md", "2025-02-17T10:00:00.000Z", `# Ordine\n\n${company} ha 800 postazioni di Orbit.`);
    const r1 = await compiler.compile(first, { useModel: true });
    expect(r1).toMatchObject({ usedModel: true, refusedWrites: 0, tokens: { prompt: 300, completion: 60 } });
    expect(r1.pages).toHaveLength(1);

    const second = await source("rinnovo.md", "2025-08-08T10:00:00.000Z", `# Rinnovo\n\n${company} passa a 975 postazioni.`);
    const r2 = await compiler.compile(second, { useModel: true });
    expect(r2.pages).toEqual(r1.pages);
    expect(calls).toBe(2);

    const page = (await PageStore.get(sql!, r1.pages[0]!))!;
    expect(page).toMatchObject({ title: company, type: "entity/company", version: 2 });
    expect(page.body).toContain(`- Postazioni: 975 ^[${second.id}#c`);
    expect(page.body).toContain(`- 2025-08-08 · Postazioni: 800 → 975 ^[${second.id}#c`);
    expect(page.body).not.toContain("- Postazioni: 800");
  });
});
