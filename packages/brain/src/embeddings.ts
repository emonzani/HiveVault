/**
 * Embedding indexer (level I2): fills `chunks.embedding` for the chunks that have none.
 *
 * - Dedup: a chunk whose text hash already has a vector of the current model (in any vault)
 *   reuses it without a model call. Email threads, attachments and repeated boilerplate
 *   make this frequent in a company archive.
 * - Context: the model input is "<page title or source name> › <heading>\n\n<text>", so a
 *   short chunk keeps the meaning given by its page.
 * - Every vector records the model that produced it (AGENTS.md invariant 3).
 * - Runs through the dispatcher at background priority: interactive queries go first.
 */
import type { Sql } from "@cb/db";
import type { ModelDispatcher, Priority } from "@cb/models";
import { normalizeModelName } from "@cb/models";
import { createLogger } from "@cb/shared";
import { defineTask } from "@cb/tasks";
import { HEADING_SEPARATOR } from "./chunker.ts";

export interface IndexerOptions {
  model: string;
  /** Texts sent to the dispatcher per call (the dispatcher splits background calls further). */
  batch?: number;
  priority?: Priority;
}

export interface IndexResult {
  embedded: number;
  reused: number;
  tokens: number;
  remaining: number;
}

const log = createLogger("brain.embeddings");
export const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;

export function embeddingInput(context: string, heading: string, text: string): string {
  const head = [context, heading].filter(Boolean).join(HEADING_SEPARATOR);
  return head ? `${head}\n\n${text}` : text;
}

export class EmbeddingIndexer {
  private readonly model: string;
  private readonly batch: number;
  private readonly priority: Priority;

  constructor(
    private readonly sql: Sql,
    private readonly dispatcher: ModelDispatcher,
    opts: IndexerOptions,
  ) {
    this.model = normalizeModelName(opts.model);
    this.batch = opts.batch ?? 64;
    this.priority = opts.priority ?? 2;
  }

  async pending(vaultId: string, sourceId?: string): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from chunks
      where vault_id = ${vaultId} and embedding is null and (${sourceId ?? null}::text is null or source_id = ${sourceId ?? null})`;
    return r!.n;
  }

  /** Embeds up to `limit` pending chunks of a vault. */
  /** `sourceId`: only the chunks of that source (the ingestion pipeline embeds what it indexed). */
  async run(vaultId: string, limit = 10_000, signal?: AbortSignal, sourceId?: string): Promise<IndexResult> {
    const result: IndexResult = { embedded: 0, reused: 0, tokens: 0, remaining: 0 };
    while (result.embedded + result.reused < limit) {
      signal?.throwIfAborted();
      const rows = await this.sql<{ id: string; hash: string; text: string; heading: string; context: string }[]>`
        select c.id, c.hash, c.text, c.heading, coalesce(p.title, s.name, '') as context
        from chunks c
        left join pages p on p.id = c.page_id
        left join sources s on s.id = c.source_id
        where c.vault_id = ${vaultId} and c.embedding is null
          and (${sourceId ?? null}::text is null or c.source_id = ${sourceId ?? null})
        order by c.id
        limit ${Math.min(this.batch, limit - result.embedded - result.reused)}`;
      if (rows.length === 0) break;

      // 1. reuse vectors of identical text
      const known = await this.sql<{ hash: string; embedding: string }[]>`
        select distinct on (hash) hash, embedding::text as embedding
        from chunks where hash = any(${rows.map((r) => r.hash)}) and embedding_model = ${this.model} and embedding is not null`;
      const byHash = new Map(known.map((k) => [k.hash, k.embedding]));

      // 2. embed the rest (one model input per distinct hash)
      const todo = rows.filter((r) => !byHash.has(r.hash));
      const unique = [...new Map(todo.map((r) => [r.hash, r])).values()];
      if (unique.length) {
        const res = await this.dispatcher.embed(
          unique.map((r) => embeddingInput(r.context, r.heading, r.text)),
          { priority: this.priority, ...(signal ? { signal } : {}) },
        );
        if (normalizeModelName(res.model) !== this.model) {
          throw new Error(`embedding model ${res.model} is not the configured ${this.model}`);
        }
        unique.forEach((r, i) => byHash.set(r.hash, vectorLiteral(res.vectors[i]!)));
        result.tokens += res.tokens;
        result.embedded += unique.length;
      }
      result.reused += rows.length - unique.length;

      const ids = rows.map((r) => r.id);
      const vecs = rows.map((r) => byHash.get(r.hash)!);
      await this.sql`
        update chunks c set embedding = u.e::halfvec, embedding_model = ${this.model}
        from unnest(${ids}::text[], ${vecs}::text[]) as u(id, e)
        where c.vault_id = ${vaultId} and c.id = u.id and c.embedding is null`;
    }
    result.remaining = await this.pending(vaultId, sourceId);
    if (result.embedded || result.reused) log.info("indexed", { vaultId, ...result });
    return result;
  }
}

/**
 * Durable task: embeds a vault in rounds of `perRound` chunks, with a checkpoint after each
 * round. A restart continues with the chunks still without a vector.
 */
export function defineEmbedVaultTask(make: () => EmbeddingIndexer, perRound = 2000) {
  return defineTask<{ vaultId: string }, { embedded: number; reused: number; tokens: number }, { embedded: number; reused: number; tokens: number }>({
    name: "embed-vault",
    version: 1,
    firstPhase: "round",
    maxAttempts: 20,
    initial: () => ({ embedded: 0, reused: 0, tokens: 0 }),
    phases: {
      round: async (c) => {
        const r = await make().run(c.task.input.vaultId, perRound, c.signal);
        const state = { embedded: c.task.state.embedded + r.embedded, reused: c.task.state.reused + r.reused, tokens: c.task.state.tokens + r.tokens };
        return r.remaining > 0 && r.embedded + r.reused > 0 ? c.next("round", state) : c.done(state);
      },
    },
  });
}
