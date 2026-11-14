/**
 * Compilation (level I3, plan §4.2 step 6) in two layers:
 *
 * 1. Extractive source page — no model needed, deterministic: title, summary, one line per
 *    part of the document with its citation, and the metadata (sender, dates, pages ...).
 *    Every compiled source has it, also when the model server is down.
 * 2. Model (when a chat model is available), in one of two modes:
 *    - extract (default, M2): one JSON extraction per part of the source, merged into the pages
 *      by code (`extract.ts`). The pages the source names are found by a name matcher before the
 *      model reads it (M5); a new title that differs from a page only in the legal form or a
 *      generic word updates that page (M6); long documents get a map of their sections (M8);
 *      a new version of a document sends to the model only the parts that changed (M9).
 *    - agent: the model reads the source and updates the pages with four tools. A page write is
 *      refused when it has no citation or cites a source that does not exist: the agent gets
 *      the reason and can correct itself (plan §11: "una frase senza fonte è scartata").
 */
import { EXTRACT_POOL, type ChatMessage, type ModelDispatcher, type ToolDefinition, type Priority } from "@cb/models";
import { classificationLevel, documentCodes, extractCitations, firstParagraph, normalizeTitle, PageStore, pageFolder, PageVersionError, parseDocument, PERSONAL, readPage, SearchEngine, serializeDocument, slugify, CLASSIFICATIONS, type Principal } from "@cb/brain";
import type { Sql } from "@cb/db";
import { createLogger, estimateTokens, metrics } from "@cb/shared";
import { EXTRACT_SYSTEM, mergeEntities, mergePage, parseExtraction, parseSections, type ExtractedEntity } from "./extract.ts";
import { VaultNames } from "./names.ts";
import type { Source, SourceStore } from "./sources.ts";

const log = createLogger("ingest.compiler");

export interface CompilerOptions {
  /** Max model turns per source. */
  maxTurns?: number;
  /** Max page writes per source. */
  maxWrites?: number;
  /** Tokens returned by one source_read call. */
  readTokens?: number;
  priority?: Priority;
  /** auto: when a real chat model is up; always: also a mock (tests); never: extractive only. */
  useModel?: "auto" | "always" | "never";
  /**
   * extract: one JSON extraction per part, merged into the pages by code (M2, default);
   * agent: the model writes the pages itself with four tools.
   */
  mode?: "extract" | "agent";
}

export interface CompileResult {
  sourcePage: string;
  pages: string[];
  usedModel: boolean;
  turns: number;
  refusedWrites: number;
  /** Model tokens of the agent (0 without the model). */
  tokens: { prompt: number; completion: number };
  /** Parts not sent to the model: unchanged since the previous version of the document (M9). */
  skippedParts: number;
}

/** A section of a long document: its chunks and its name (M8). */
interface Section {
  start: number;
  end: number;
  name: string;
}

/** What the model found in a source, before it is written into the pages. */
interface Extraction {
  entities: ExtractedEntity[];
  /** One sentence per section, by the chunk the section starts at. */
  sections: Map<number, string>;
  /** Sections of the document (empty for a short one). */
  map: Section[];
  tokens: { prompt: number; completion: number };
  turns: number;
  skippedParts: number;
  /**
   * The names of the vault read once for the whole compile: every page write changes the vault
   * version, and reading them again for each entity would load every alias of the vault each time.
   * Entities of this compile with the same key are one entity already (mergeEntities).
   */
  names: VaultNames;
}

/** Documents with at least this many chunks get a map of their sections (M8). */
const LONG_DOC = 8;
/** At most this many sections in a map; more go by part of the document. */
const MAX_SECTIONS = 40;

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "source_read",
      description: "Legge la sorgente da compilare, una parte alla volta. Ogni parte ha l'id da citare (^[id]).",
      parameters: { type: "object", properties: { part: { type: "integer", minimum: 0, description: "Parte da leggere, da 0" } }, required: ["part"] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_search",
      description: "Cerca nel wiki del vault pagine esistenti (entità, concetti, decisioni) da aggiornare invece di duplicarle.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_read",
      description: "Legge una pagina del wiki per id o titolo.",
      parameters: { type: "object", properties: { page: { type: "string" } }, required: ["page"] },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_write",
      description:
        "Crea o sostituisce una pagina del wiki. Markdown completo con frontmatter (title, type, aliases, tldr). Ogni punto di '## Stato attuale' deve citare una fonte con ^[id].",
      parameters: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
    },
  },
];

const ALLOWED_TYPES = /^(entity(\/[a-z-]+)?|concept|decision|synthesis)$/;

export class Compiler {
  private readonly o: Required<CompilerOptions>;
  /** Names of the pages of the recent vaults, at their vault version (M5). */
  private readonly names = new Map<string, VaultNames>();

  constructor(
    private readonly sql: Sql,
    private readonly store: SourceStore,
    private readonly pages: PageStore,
    private readonly search: SearchEngine,
    private readonly dispatcher: ModelDispatcher | undefined,
    o: CompilerOptions = {},
  ) {
    this.o = { maxTurns: o.maxTurns ?? 16, maxWrites: o.maxWrites ?? 15, readTokens: o.readTokens ?? 3000, priority: o.priority ?? 1, useModel: o.useModel ?? "auto", mode: o.mode ?? "extract" };
  }

  /** True when a real (non-fallback) chat model is up. */
  modelAvailable(): boolean {
    return !!this.dispatcher?.snapshot().endpoints.some((e) => e.kind === "chat" && e.status === "up" && e.origin !== "mock");
  }

  /** `priority`: of the model calls (default the option `priority`); idle compiles use 2. */
  async compile(src: Source, o: { useModel?: boolean; signal?: AbortSignal; priority?: Priority } = {}): Promise<CompileResult> {
    const t0 = Date.now();
    const useModel = o.useModel ?? (this.o.useModel === "always" ? true : this.o.useModel === "never" ? false : this.modelAvailable());
    const model = useModel && !!this.dispatcher;
    const priority = o.priority ?? this.o.priority;
    // the model reads first: the source page carries the map of the sections it wrote
    const ex = model && this.o.mode === "extract" ? await this.extract(src, priority, o.signal) : null;
    const sourcePage = await this.sourcePage(src, ex);
    const result: CompileResult = { sourcePage, pages: [], usedModel: false, turns: 0, refusedWrites: 0, tokens: { prompt: 0, completion: 0 }, skippedParts: 0 };
    if (model) Object.assign(result, await (ex ? this.writeAll(src, ex) : this.agent(src, priority, o.signal)), { sourcePage });
    // a model compile is recorded: a new version of the document skips its unchanged parts (M9)
    const ms = Date.now() - t0;
    // M20: the text compiled with the model; a reingest that extracts the same text skips the compilation.
    // M14: the time of a model compile, for the estimated wait of the queue.
    await this.store.update(src.id, { compiled_page: sourcePage, level: 3, status: "compiled" }, model ? { compiledWith: this.o.mode, compiledSha: src.extractedSha, compileMs: ms } : undefined);
    // M19: what the compiler does, per mode (bounded labels)
    const mode = model ? this.o.mode : "extractive";
    metrics.inc("compile_sources", { mode });
    metrics.observe("compile_ms", ms, { mode });
    metrics.inc("compile_pages", { mode }, result.pages.length);
    metrics.inc("compile_refused", { mode }, result.refusedWrites);
    metrics.inc("compile_parts_skipped", { mode }, result.skippedParts);
    await this.store.log(src.vaultId, "compile", src.title ?? src.name, src.id, { pages: result.pages.length, model: result.usedModel }, src.classification);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Layer 1: extractive source page
  // ---------------------------------------------------------------------------
  private async sourcePage(src: Source, ex: Extraction | null = null): Promise<string> {
    const chunks = await this.store.chunks(src);
    const title = (src.title ?? src.name).replace(/\s+/g, " ").trim().slice(0, 150) || src.name;
    const text = chunks.map((c) => c.text).join("\n\n");
    const cite = (ord: number) => `^[${src.id}#c${ord}]`;
    const sentence = (t: string) => {
      const flat = t.replace(/[#*>|`_]/g, " ").replace(/\s+/g, " ").trim();
      const m = /^(.{40,220}?[.!?])(\s|$)/.exec(flat);
      return (m?.[1] ?? flat.slice(0, 200)).trim();
    };
    const parts = chunks.slice(0, 40).map((c) => `- ${c.heading ? `**${c.heading.split(" › ").pop()}**: ` : ""}${sentence(c.text)} ${cite(c.ord)}`);
    const meta = src.meta ?? {};
    const facts = Object.entries({
      Da: meta.from,
      A: meta.to,
      Data: meta.date,
      Oggetto: meta.subject,
      Autore: meta.author,
      Pagine: meta.pages,
      Fogli: Array.isArray(meta.sheets) ? (meta.sheets as { name: string }[]).map((s) => s.name).join(", ") : undefined,
      Slide: meta.slides,
      Formato: src.mime,
      Origine: src.path ?? src.origin,
    })
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`);
    const tldr = (firstParagraph(text, 280) || sentence(text)).replace(/\s+/g, " ");
    // M8: one line per section of a long document, written by the model, with its citation
    const map = (ex?.map ?? [])
      .filter((s) => ex!.sections.has(s.start))
      .map((s) => `- **${s.name}** (${s.start === s.end ? `c${s.start}` : `c${s.start}–c${s.end}`}): ${ex!.sections.get(s.start)} ${cite(s.start)}`);
    const body = [
      `# ${title}`,
      "",
      `## Sintesi`,
      "",
      `${tldr} ${chunks.length ? cite(0) : ""}`.trim(),
      "",
      ...(map.length ? [`## Mappa`, "", ...map, ""] : []),
      `## Contenuto`,
      "",
      ...(parts.length ? parts : ["- (nessun testo estratto)"]),
      ...(chunks.length > 40 ? ["", `> Il documento ha ${chunks.length} parti: qui le prime 40.`] : []),
      "",
      `## Metadati`,
      "",
      ...facts,
    ].join("\n");
    const r = await this.pages.upsert({
      vaultId: src.vaultId,
      path: `sources/${slugify(title)}-${src.id.slice(-6).toLowerCase()}.md`,
      frontmatter: {
        title,
        type: "source",
        tldr,
        source: src.id,
        // the file name, and the code of the document: links write "[[ETSI EN 319 522-2]]"
        aliases: [...new Set([...(src.name !== title ? [src.name] : []), ...documentCodes(title, body)])],
        classification: CLASSIFICATIONS[src.classification],
      },
      body,
      author: "compiler:extractive",
    });
    return r.page.id;
  }

  /** Consecutive chunks of about `readTokens` tokens: what the model reads at once. */
  private parts(chunks: { tokens: number }[]): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    for (let i = 0, budget = 0, from = 0; i < chunks.length; i++) {
      budget += chunks[i]!.tokens;
      if (budget >= this.o.readTokens || i === chunks.length - 1) {
        out.push({ from, to: i });
        from = i + 1;
        budget = 0;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Layer 2a: structured extraction (M2)
  // ---------------------------------------------------------------------------
  /** The names of the pages of a vault, loaded again when the vault version changed (M5). */
  private async vaultNames(vaultId: string): Promise<VaultNames> {
    const [v] = await this.sql<{ version: number }[]>`select version from vaults where id = ${vaultId}`;
    const cached = this.names.get(vaultId);
    if (cached && cached.version === Number(v?.version ?? 0)) return cached;
    const names = await VaultNames.load(this.sql, vaultId);
    this.names.delete(vaultId);
    this.names.set(vaultId, names);
    if (this.names.size > 32) this.names.delete(this.names.keys().next().value!);
    return names;
  }

  /**
   * Sections of a long document (M8): runs of chunks under the same heading, at the first
   * heading level that splits the document; without headings, the parts the model reads.
   */
  private sectionsOf(chunks: { ord: number; heading: string }[], parts: { from: number; to: number }[]): Section[] {
    if (chunks.length < LONG_DOC) return [];
    for (let depth = 1; depth <= 3; depth++) {
      const runs: Section[] = [];
      for (const c of chunks) {
        const path = c.heading.split(" › ").map((h) => h.trim()).filter(Boolean).slice(0, depth);
        const key = path.join(" › ");
        const last = runs.at(-1);
        if (last && (last as Section & { key?: string }).key === key) last.end = c.ord;
        else runs.push(Object.assign({ start: c.ord, end: c.ord, name: path.at(-1) ?? "" }, { key }));
      }
      if (runs.length > MAX_SECTIONS) break;
      if (runs.length >= 2 && runs.every((r) => r.name)) return runs.map(({ start, end, name }) => ({ start, end, name: name.slice(0, 80) }));
    }
    if (parts.length < 2) return [];
    return parts.slice(0, MAX_SECTIONS).map((p, i) => ({ start: chunks[p.from]!.ord, end: chunks[p.to]!.ord, name: `Parte ${i + 1}` }));
  }

  /**
   * The previous version of the same document (M9): same path (imports, links) or, without a
   * path, same name (uploads); compiled with the model and with the same classification.
   * Its chunk hashes and the sentences of its sections.
   */
  private async previousVersion(src: Source): Promise<{ id: string; hashes: Set<string>; sections: Record<string, string> } | null> {
    const [p] = await this.sql<{ id: string; sections: Record<string, string> | null }[]>`
      select id, meta->'sections' as sections from sources
      where vault_id = ${src.vaultId} and id <> ${src.id} and level = 3 and meta ? 'compiledWith'
        and classification = ${src.classification} and created_at <= ${src.createdAt}
        and (case when ${src.path}::text is not null then path = ${src.path}
                  else path is null and origin <> 'attachment' and ${src.origin} <> 'attachment' and name = ${src.name} end)
      order by created_at desc, id desc limit 1`;
    if (!p) return null;
    const rows = await this.sql<{ hash: string }[]>`select hash from chunks where vault_id = ${src.vaultId} and source_id = ${p.id}`;
    return { id: p.id, hashes: new Set(rows.map((r) => r.hash)), sections: p.sections ?? {} };
  }

  private async extract(src: Source, priority: Priority, signal?: AbortSignal): Promise<Extraction> {
    const personal = src.classification === PERSONAL;
    const chunks = await this.store.chunks(src);
    const parts = this.parts(chunks);
    const map = this.sectionsOf(chunks, parts);
    const names = await this.vaultNames(src.vaultId);
    const prev = await this.previousVersion(src);
    const hashOf = new Map(chunks.map((c) => [c.ord, c.hash]));
    const sections = new Map<number, string>();
    const tokens = { prompt: 0, completion: 0 };
    let skippedParts = 0;
    let turns = 0;
    const sourceDate = await this.dateOf(src.id);
    // the parts are independent: with several chat endpoints they run at the same time
    const lists = await Promise.all(
      parts.map(async (p) => {
        const part = chunks.slice(p.from, p.to + 1);
        const own = map.filter((s) => s.start >= part[0]!.ord && s.start <= part.at(-1)!.ord);
        // M9: a part the previous version had word for word was extracted then; its facts cite it
        if (prev && part.every((c) => prev.hashes.has(c.hash))) {
          skippedParts++;
          for (const s of own) {
            const t = prev.sections[hashOf.get(s.start)!];
            if (t) sections.set(s.start, t);
          }
          return [];
        }
        const text = part.map((c) => `[c${c.ord}]${c.heading ? ` (${c.heading})` : ""}\n${c.text}`).join("\n\n");
        // M5: pages of the vault named in the part; the model reuses their titles
        const known = names.find(text, personal);
        const user = [
          `Documento: "${src.title ?? src.name}"${sourceDate ? ` del ${sourceDate}` : ""}`,
          known.length ? `Pagine esistenti (titolo — tipo):\n${known.map((k) => `- ${k.title} — ${k.type}`).join("\n")}` : "",
          own.length ? `Sezioni (una frase ciascuna in "sections"):\n${own.map((s) => `- [c${s.start}] ${s.name}`).join("\n")}` : "",
          `Testo:\n\n${text}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        signal?.throwIfAborted();
        turns++;
        const r = await this.dispatcher!.chat(
          { messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: user }], maxTokens: 3000 + own.length * 80, temperature: 0, thinking: false },
          { priority, pool: EXTRACT_POOL, ...(signal ? { signal } : {}) },
        );
        tokens.prompt += r.usage.promptTokens;
        tokens.completion += r.usage.completionTokens;
        for (const [k, v] of parseSections(r.content, new Set(own.map((s) => s.start)))) sections.set(k, v);
        const out = parseExtraction(r.content, new Set(part.map((c) => c.ord)));
        if (!out) log.warn("extraction not JSON", { source: src.id, part: p.from, finish: r.finishReason });
        return out ?? [];
      }),
    );
    if (sections.size) {
      // by chunk hash: the next version of the document reuses the sentences of unchanged sections
      await this.store.update(src.id, {}, { sections: Object.fromEntries([...sections].map(([ord, t]) => [hashOf.get(ord)!, t])) });
    }
    return { entities: mergeEntities(lists).slice(0, this.o.maxWrites), sections, map, tokens, turns, skippedParts, names };
  }

  /** Writes the entities of an extraction into their pages. */
  private async writeAll(src: Source, ex: Extraction): Promise<Omit<CompileResult, "sourcePage">> {
    const personal = src.classification === PERSONAL;
    const { entities, tokens } = ex;
    const sourceDate = await this.dateOf(src.id);
    const linkable = new Map(entities.map((e) => [normalizeTitle(e.title), e.title] as [string, string]));
    const pages = new Set<string>();
    let refused = 0;
    for (const e of entities) {
      // a concurrent write (another compile, the crosslink) wins; the merge reads the page again
      for (let attempt = 0; ; attempt++) {
        try {
          const id = await this.writeEntity(src, e, sourceDate, linkable, personal, ex.names);
          if (id === null) refused++;
          else pages.add(id);
          break;
        } catch (err) {
          if (!(err instanceof PageVersionError) || attempt >= 2) throw err;
        }
      }
    }
    log.info("extracted", { source: src.id, parts: ex.turns, skipped: ex.skippedParts, entities: entities.length, pages: pages.size, refused });
    return { pages: [...pages], usedModel: true, turns: ex.turns, refusedWrites: refused, tokens, skippedParts: ex.skippedParts };
  }

  /**
   * YYYY-MM-DD of a source: its own date (email, document metadata). Not the upload time: an
   * old offer uploaded today is not newer than the contract it came before.
   */
  private async dateOf(sourceId: string): Promise<string | null> {
    const [r] = await this.sql<{ d: string | null }[]>`select coalesce(meta->>'date', meta->>'created') as d from sources where id = ${sourceId}`;
    return /^\d{4}-\d{2}-\d{2}/.exec(r?.d ?? "")?.[0] ?? null;
  }

  /** Merges one entity into its page (found by title or alias) or into a new page. Null: refused. */
  private async writeEntity(src: Source, e: ExtractedEntity, sourceDate: string | null, linkable: Map<string, string>, personal: boolean, vault: VaultNames): Promise<string | null> {
    const names = [...new Set([e.title, ...e.aliases].map(normalizeTitle).filter(Boolean))];
    const [hit] = await this.sql<{ id: string }[]>`
      select p.id from aliases a join pages p on p.id = a.page_id
      where a.vault_id = ${src.vaultId} and a.alias_norm = any(${names})
        and split_part(p.type, '/', 1) <> 'source' and not (p.frontmatter ? 'hive_subject') and p.path not like '\\_inbox/%'
        and (p.classification = ${PERSONAL}) = ${personal}
      order by a.is_title desc, p.importance desc, p.id limit 1`;
    // M6: no page with this name, but one whose name differs only in the legal form or a generic word
    const similar = hit ? null : vault.similar([e.title, ...e.aliases], e.type, personal);
    if (similar) metrics.inc("compile_duplicates", { mode: "extract", outcome: "merged" });
    const id = hit?.id ?? similar?.id;
    const page = id ? await PageStore.get(this.sql, id) : null;
    const cited = page ? [...new Set(extractCitations(page.body).map((c) => c.source))] : [];
    const dates = new Map<string, string>();
    if (cited.length) {
      for (const r of await this.sql<{ id: string; d: string }[]>`select id, coalesce(meta->>'date', meta->>'created') as d from sources where id = any(${cited})`) {
        const d = /^\d{4}-\d{2}-\d{2}/.exec(r.d)?.[0];
        if (d) dates.set(r.id, d);
      }
    }
    const m = mergePage({ existing: page ? { frontmatter: page.frontmatter, body: page.body } : null, entity: e, sourceId: src.id, sourceDate, citedDates: dates, linkable });
    if (page && m.body === page.body && JSON.stringify(m.frontmatter) === JSON.stringify(page.frontmatter)) return page.id;
    const markdown = this.atLeast(src, serializeDocument(m.frontmatter, m.body));
    const v = await this.validate(src, markdown);
    if (v.error) {
      log.info("extracted page refused", { source: src.id, error: v.error });
      return null;
    }
    const w = await this.pages.upsert({
      vaultId: src.vaultId,
      markdown,
      author: `compiler:${src.id}`,
      ...(page ? { id: page.id, path: page.path, ifVersion: page.version } : {}),
    });
    if (!m.frontmatter.tldr) metrics.inc("compile_no_tldr", { mode: "extract" });
    return w.page.id;
  }

  // ---------------------------------------------------------------------------
  // Layer 2: model agent
  // ---------------------------------------------------------------------------
  private async agent(src: Source, priority: Priority, signal?: AbortSignal): Promise<Omit<CompileResult, "sourcePage">> {
    const personal = src.classification === PERSONAL;
    // a personal source may read the personal pages of its vault; any other source never sees them
    const principal: Principal = { id: "system:compiler", vaults: [src.vaultId], clearance: 3, ...(personal ? { personal: [src.vaultId] } : {}) };
    const [vault] = await this.sql<{ schema_md: string; name: string }[]>`select schema_md, name from vaults where id = ${src.vaultId}`;
    const chunks = await this.store.chunks(src);
    // M5: first the pages the source names, then the most important ones of the vault
    const names = await this.vaultNames(src.vaultId);
    const named = names.find(chunks.map((c) => c.text).join("\n").slice(0, 400_000), personal, 60);
    const top = await this.sql<{ title: string; type: string }[]>`
      select title, type from pages where vault_id = ${src.vaultId} and type <> 'source' and (${personal} or classification <> ${PERSONAL})
      order by importance desc, updated_at desc limit 60`;
    const recent = [...named, ...top.filter((t) => !named.some((n) => n.title === t.title))].slice(0, 60);
    const partsOf = this.parts(chunks);
    const system = [
      `Sei il compilatore del wiki aziendale "${vault?.name}". Aggiorni le pagine del wiki con quello che dice una nuova sorgente.`,
      "Regole:",
      "1. Leggi la sorgente con source_read (tutte le parti).",
      "2. Per ogni persona, azienda, progetto, prodotto, concetto o decisione rilevante: cerca la pagina con wiki_search; se esiste, leggila con wiki_read e riscrivila completa con wiki_write integrando i fatti nuovi; altrimenti creala.",
      "3. Formato: frontmatter con title, type (entity/person, entity/company, entity/project, concept, decision), aliases, tldr; poi '## Stato attuale' (fatti correnti, un punto per fatto) e '## Timeline' (eventi datati, il più recente in alto).",
      `4. Ogni punto cita la fonte: ^[${src.id}#c<numero parte>] o le citazioni già presenti. Niente fatti senza fonte.`,
      "5. Se un fatto contraddice la pagina, non cancellare: aggiungi un blocco '> [!conflict]' con le due versioni e le loro fonti.",
      "6. Scrivi in italiano, in modo conciso. Quando hai finito rispondi solo FINE.",
      vault?.schema_md ? `Schema del vault:\n${vault.schema_md.slice(0, 4000)}` : "",
      recent.length ? `Pagine esistenti (titolo — tipo):\n${recent.map((p) => `- ${p.title} — ${p.type}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `Nuova sorgente ${src.id}: "${src.title ?? src.name}" (${partsOf.length} parti, ${src.textTokens ?? 0} token). Compilala nel wiki.` },
    ];
    const pages = new Set<string>();
    let refused = 0;
    let writes = 0;
    let turns = 0;
    const tokens = { prompt: 0, completion: 0 };
    for (; turns < this.o.maxTurns; turns++) {
      signal?.throwIfAborted();
      const r = await this.dispatcher!.chat({ messages, tools: TOOLS }, { priority, ...(signal ? { signal } : {}) });
      tokens.prompt += r.usage.promptTokens;
      tokens.completion += r.usage.completionTokens;
      // llama-server parses the arguments of every earlier tool call when it applies the chat template:
      // one call with broken JSON in the history makes every later request fail with HTTP 500.
      // Echo such a call with "{}" and tell the model to send it again.
      const calls = r.toolCalls.map((call) => {
        try {
          const args = JSON.parse(call.function.arguments || "{}") as unknown;
          if (args && typeof args === "object" && !Array.isArray(args)) return { call, args: args as Record<string, unknown> };
        } catch {
          // handled below
        }
        return { call: { ...call, function: { ...call.function, arguments: "{}" } }, args: null };
      });
      messages.push({ role: "assistant", content: r.content, ...(calls.length ? { tool_calls: calls.map((c) => c.call) } : {}) });
      if (!calls.length) break;
      for (const { call, args } of calls) {
        let out: string;
        try {
          if (!args) throw new Error(`gli argomenti di ${call.function.name} non sono JSON valido (forse troppo lunghi o con virgolette non escapate). Invia di nuovo la chiamata con un oggetto JSON valido.`);
          switch (call.function.name) {
            case "source_read": {
              const p = partsOf[Number(args.part ?? 0)];
              out = p
                ? `Parte ${Number(args.part ?? 0)} di ${partsOf.length}:\n\n` +
                  chunks
                    .slice(p.from, p.to + 1)
                    .map((c) => `[${src.id}#c${c.ord}]${c.heading ? ` (${c.heading})` : ""}\n${c.text}`)
                    .join("\n\n")
                : `Parte inesistente: la sorgente ha ${partsOf.length} parti (0–${partsOf.length - 1}).`;
              break;
            }
            case "wiki_search": {
              const s = await this.search.search(principal, String(args.query ?? ""), { includeSources: false, limit: 8, maxTokens: 1500 });
              out = s.hits.length ? s.hits.map((h) => `- ${h.title} (id ${h.id}, ${h.type}): ${h.tldr}`).join("\n") : "Nessuna pagina trovata.";
              break;
            }
            case "wiki_read": {
              const p = await readPage(this.sql, principal, String(args.page ?? ""), { maxTokens: 2500 });
              out = p ? `id ${p.id}\n${p.content}` : "Pagina non trovata.";
              break;
            }
            case "wiki_write": {
              if (writes >= this.o.maxWrites) {
                out = `Limite di ${this.o.maxWrites} pagine raggiunto per questa sorgente. Rispondi FINE.`;
                break;
              }
              const v = await this.validate(src, String(args.markdown ?? ""));
              if (v.error) {
                refused++;
                out = `Pagina rifiutata: ${v.error}`;
                break;
              }
              const dup = await this.duplicateOf(src, String(args.markdown), names);
              if (dup) {
                refused++;
                metrics.inc("compile_duplicates", { mode: "agent", outcome: "refused" });
                out = `Pagina rifiutata: esiste già «${dup.title}» (id ${dup.id}), la stessa entità con un altro nome. Leggila con wiki_read e riscrivila con il suo titolo.`;
                break;
              }
              const w = await this.pages.upsert({ vaultId: src.vaultId, markdown: this.atLeast(src, String(args.markdown)), author: `compiler:${src.id}` });
              if (!parseDocument(String(args.markdown)).frontmatter.tldr) metrics.inc("compile_no_tldr", { mode: "agent" });
              writes++;
              pages.add(w.page.id);
              out = `Salvata: ${w.page.title} (id ${w.page.id}, ${w.created ? "nuova" : w.changed ? "aggiornata" : "invariata"}).`;
              break;
            }
            default:
              out = `Strumento sconosciuto: ${call.function.name}`;
          }
        } catch (e) {
          out = `Errore: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: out.slice(0, 20_000) });
      }
    }
    log.info("compiled", { source: src.id, pages: pages.size, turns, refused, tokens: tokens.prompt + tokens.completion });
    return { pages: [...pages], usedModel: true, turns, refusedWrites: refused, tokens, skippedParts: 0 };
  }

  /**
   * M6 for the agent: a new page whose title differs from an existing page of the same type only
   * in the legal form or a generic word. Null when the title (or the id) names a page already.
   */
  private async duplicateOf(src: Source, markdown: string, names: VaultNames): Promise<{ id: string; title: string } | null> {
    const doc = parseDocument(markdown);
    if (typeof doc.frontmatter.id === "string") return null;
    const title = String(doc.frontmatter.title ?? "").trim();
    const type = String(doc.frontmatter.type ?? "").trim();
    const personal = src.classification === PERSONAL;
    const [exists] = await this.sql`
      select 1 from aliases a join pages p on p.id = a.page_id
      where a.vault_id = ${src.vaultId} and a.alias_norm = ${normalizeTitle(title)} and (p.classification = ${PERSONAL}) = ${personal} limit 1`;
    if (exists) return null;
    return names.similar([title], type, personal);
  }

  /**
   * A page written from a source is at least as restricted as the source: facts of a
   * "riservato" document do not become "interno", facts of a "personale" one stay personal.
   */
  atLeast(src: Source, markdown: string): string {
    const doc = parseDocument(markdown);
    const level = classificationLevel(doc.frontmatter.classification, 0);
    if (doc.frontmatter.classification !== undefined && level >= src.classification) return markdown;
    return serializeDocument({ ...doc.frontmatter, classification: CLASSIFICATIONS[Math.max(level, src.classification)] }, doc.body);
  }

  /** The checks every model-written page must pass. */
  async validate(src: Source, markdown: string): Promise<{ error?: string }> {
    const doc = parseDocument(markdown);
    const title = String(doc.frontmatter.title ?? "").trim();
    const type = String(doc.frontmatter.type ?? "").trim();
    if (!title) return { error: "manca il titolo (frontmatter title)." };
    if (!ALLOWED_TYPES.test(type)) return { error: `tipo "${type}" non ammesso: usa entity/<tipo>, concept, decision o synthesis.` };
    if (estimateTokens(doc.body) > 6000) return { error: "pagina troppo lunga (oltre 6000 token): sintetizza." };
    const cites = extractCitations(doc.body);
    if (!cites.length) return { error: "nessuna citazione: ogni fatto deve citare la fonte con ^[id]." };
    const state = /^## Stato attuale\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m.exec(doc.body)?.[1] ?? "";
    const uncited = state.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l) && !/\^\[[^\]]+\]/.test(l));
    if (uncited.length) return { error: `${uncited.length} punti di "Stato attuale" senza citazione, per esempio: "${uncited[0]!.trim().slice(0, 80)}".` };
    const ids = [...new Set(cites.map((c) => c.source))];
    const known = await this.sql<{ id: string }[]>`
      select id from sources where vault_id = ${src.vaultId} and id = any(${ids})
      union select id from pages where vault_id = ${src.vaultId} and id = any(${ids})`;
    const missing = ids.filter((i) => !known.some((k) => k.id === i));
    if (missing.length) return { error: `citazioni a fonti inesistenti: ${missing.slice(0, 3).join(", ")}.` };
    // personal and other pages never overwrite each other: the history of the page would show
    // personal text to the other readers, or hide a shared page from them
    const fmId = typeof doc.frontmatter.id === "string" ? doc.frontmatter.id : null;
    const path = typeof doc.frontmatter.path === "string" ? doc.frontmatter.path : `${pageFolder(type)}/${slugify(title)}.md`;
    const [clash] = await this.sql`
      select 1 from pages where vault_id = ${src.vaultId} and (id = ${fmId} or path = ${path})
        and (classification = ${PERSONAL}) <> ${src.classification === PERSONAL} limit 1`;
    if (clash) return { error: `il titolo «${title}» è già usato da un'altra pagina: scegline uno diverso.` };
    return {};
  }
}
