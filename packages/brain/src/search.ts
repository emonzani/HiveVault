/**
 * Hybrid search (plan §6.1), one SQL round trip inside the reader role:
 *
 *   full-text (GIN, it+en)      ─┐
 *   vectors: binary HNSW + rescoring (vaults with vector_index=binary)
 *            halfvec HNSW        (vaults with vector_index=full)      ├─ RRF (k=60) ─ group by page/source
 *   title / alias similarity    ─┘
 *
 * Then: boosts (compiled pages over raw sources, title matches), optional local rerank,
 * snippets, token budget. The ACL is a partition filter (`vault_id = any(...)`) plus RLS.
 * Results are cached per principal, query and vault versions: a write in any of the
 * searched vaults changes the key, so the cache is never stale.
 */
import type { Sql, TransactionSql } from "@cb/db";
import { normalizeModelName, type ModelDispatcher } from "@cb/models";
import { createLogger, estimateTokens, metrics } from "@cb/shared";
import { withReader, type Principal } from "./access.ts";
import { vectorLiteral } from "./embeddings.ts";
import { normalizeTitle } from "./markdown.ts";
import { binExpr, vecExpr, type Vault } from "./vaults.ts";

export type Level = "I1" | "I2" | "I3";

export interface SearchOptions {
  /** Restrict to some of the principal's vaults. */
  vaults?: string[];
  /** Page types ("entity", "entity/company", "decision", ...) — prefix match. Sources are excluded when set. */
  types?: string[];
  includeSources?: boolean;
  limit?: number;
  /** Budget for the returned snippets (the hit still reports the tokens of the full page). */
  maxTokens?: number;
  rerank?: boolean;
  /** Hits re-scored by the reranker (default 20). Fewer is faster on a CPU reranker. */
  rerankTop?: number;
  candidates?: number;
}

export interface SearchChunk {
  id: string;
  heading: string;
  blockId: string | null;
  snippet: string;
  score: number;
}

export interface SearchHit {
  kind: "page" | "source";
  id: string;
  vaultId: string;
  title: string;
  type: string;
  tldr: string;
  level: Level;
  classification: number;
  /** Tokens to read the whole page (or the whole source text). */
  tokens: number;
  score: number;
  /** Stable citation: page id or source id, with the best block/chunk. */
  cite: string;
  chunks: SearchChunk[];
  matchedTitle: boolean;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  totalTokens: number;
  /** Branches that could not run (e.g. "vector" when the embedding model is down). */
  degraded: string[];
  tookMs: number;
  cached: boolean;
}

export interface SearchEngineOptions {
  dims: number;
  embedModel: string;
  queryPrefix?: string;
  cacheSize?: number;
  cacheTtlMs?: number;
  /** Max wait for the query embedding before falling back to full-text only. */
  embedTimeoutMs?: number;
  /**
   * Vector candidates below this cosine similarity are dropped. Nearest neighbors always
   * exist, also for a query about something the memory does not contain: without a floor
   * they come back as noise. The right value depends on the model (calibrate with the
   * evaluation set); 0 disables the floor.
   */
  minVectorSimilarity?: number;
}

interface Row {
  vault_id: string;
  id: string;
  page_id: string | null;
  source_id: string | null;
  heading: string;
  block_id: string | null;
  text: string;
  score: number;
  title: string;
  type: string;
  tldr: string;
  tokens: number;
  classification: number;
  has_vec: boolean;
  title_hit: boolean;
}

const log = createLogger("brain.search");
const RRF_K = 60;

export class SearchEngine {
  private readonly cache = new Map<string, { at: number; result: SearchResult }>();
  private vaultInfo = new Map<string, Pick<Vault, "id" | "vectorIndex">>();
  private vaultInfoAt = 0;

  constructor(
    private readonly sql: Sql,
    private readonly dispatcher: ModelDispatcher | undefined,
    private readonly o: SearchEngineOptions,
  ) {
    if (!Number.isInteger(o.dims) || o.dims <= 0 || o.dims > 4096) throw new Error(`invalid dims ${o.dims}`);
  }

  async search(p: Principal, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const t0 = performance.now();
    const q = query.trim();
    const vaults = (opts.vaults ? opts.vaults.filter((v) => p.vaults.includes(v)) : p.vaults).slice().sort();
    const empty = (degraded: string[] = []): SearchResult => ({ query: q, hits: [], totalTokens: 0, degraded, tookMs: performance.now() - t0, cached: false });
    if (!q || vaults.length === 0) return empty();

    const versions = await this.sql<{ id: string; version: number }[]>`select id, version from vaults where id = any(${vaults}) order by id`;
    const key = JSON.stringify([p.clearance, (p.personal ?? []).filter((v) => vaults.includes(v)).sort(), vaults, versions.map((v) => Number(v.version)), normalizeTitle(q), opts]);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.o.cacheTtlMs ?? 10 * 60_000)) {
      this.cache.delete(key);
      this.cache.set(key, hit); // LRU: move to the end
      metrics.inc("search_requests", { cache: "hit", result: hit.result.hits.length ? "hits" : "empty" });
      metrics.observe("search_ms", performance.now() - t0, { branch: "total" });
      return { ...hit.result, cached: true, tookMs: performance.now() - t0 };
    }

    const degraded: string[] = [];
    const info = await this.vaultIndexes(vaults);
    const vectorVaults = vaults.filter((v) => info.get(v)?.vectorIndex !== "none");
    let qvec: string | null = null;
    const tEmbed = performance.now();
    if (vectorVaults.length && this.dispatcher) {
      try {
        const r = await this.dispatcher.embed([(this.o.queryPrefix ?? "") + q], {
          priority: 0,
          signal: AbortSignal.timeout(this.o.embedTimeoutMs ?? 3000),
        });
        qvec = vectorLiteral(r.vectors[0]!);
      } catch (err) {
        degraded.push("vector");
        log.warn("query embedding unavailable: full-text only", { error: String((err as Error).message ?? err) });
      }
    } else if (vectorVaults.length) {
      degraded.push("vector");
    }

    const limit = opts.limit ?? 10;
    const cand = opts.candidates ?? 200;
    const binVaults = qvec ? vaults.filter((v) => info.get(v)?.vectorIndex === "binary") : [];
    const fullVaults = qvec ? vaults.filter((v) => info.get(v)?.vectorIndex === "full") : [];
    const typePrefixes = opts.types?.map((t) => `${t}%`) ?? null;
    const includeSources = opts.includeSources ?? !opts.types;

    if (qvec) metrics.observe("search_ms", performance.now() - tEmbed, { branch: "embed" });
    const tSql = performance.now();
    const rows = await withReader(this.sql, { ...p, vaults }, (tx) =>
      this.query(tx, { q, qvec, vaults, binVaults, fullVaults, cand, typePrefixes, includeSources, limit }),
    );

    metrics.observe("search_ms", performance.now() - tSql, { branch: "sql" });
    let hits = this.group(rows, q);
    if (opts.rerank && hits.length > 1 && this.dispatcher) {
      const tRerank = performance.now();
      try {
        const n = Math.max(2, opts.rerankTop ?? 20);
        const top = hits.slice(0, n);
        const r = await this.dispatcher.rerank(q, top.map((h) => `${h.title}\n${h.chunks[0]?.snippet ?? h.tldr}`), { priority: 0 });
        top.forEach((h, i) => (h.score = r.scores[i]!));
        hits = [...top.sort((a, b) => b.score - a.score), ...hits.slice(n)];
        metrics.observe("search_ms", performance.now() - tRerank, { branch: "rerank" });
      } catch {
        degraded.push("rerank");
      }
    }

    // Token budget: whole hits, best first; at least one hit is always returned.
    const budget = opts.maxTokens ?? 4000;
    const out: SearchHit[] = [];
    let used = 0;
    for (const h of hits.slice(0, limit)) {
      const cost = estimateTokens(h.title + h.tldr + h.chunks.map((c) => c.snippet).join(" ")) + 12;
      if (out.length && used + cost > budget) break;
      out.push(h);
      used += cost;
    }
    const result: SearchResult = { query: q, hits: out, totalTokens: used, degraded, tookMs: performance.now() - t0, cached: false };
    metrics.inc("search_requests", { cache: "miss", result: out.length ? "hits" : "empty" });
    metrics.observe("search_ms", result.tookMs, { branch: "total" });
    for (const d of degraded) metrics.inc("search_degraded", { branch: d });
    this.remember(key, result);
    return result;
  }

  private remember(key: string, result: SearchResult): void {
    this.cache.set(key, { at: Date.now(), result });
    const max = this.o.cacheSize ?? 1000;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value!);
  }

  private async vaultIndexes(ids: string[]): Promise<Map<string, Pick<Vault, "id" | "vectorIndex">>> {
    if (Date.now() - this.vaultInfoAt > 30_000 || ids.some((id) => !this.vaultInfo.has(id))) {
      const rows = await this.sql<Pick<Vault, "id" | "vectorIndex">[]>`select id, vector_index as "vectorIndex" from vaults`;
      this.vaultInfo = new Map(rows.map((r) => [r.id, r]));
      this.vaultInfoAt = Date.now();
    }
    return this.vaultInfo;
  }

  /**
   * Diagnostics: the execution plan of the search query for this principal and text
   * (EXPLAIN ANALYZE, run inside the reader role like a real search).
   */
  async explain(p: Principal, query: string, opts: SearchOptions = {}): Promise<string[]> {
    const vaults = (opts.vaults ? opts.vaults.filter((v) => p.vaults.includes(v)) : p.vaults).slice().sort();
    const info = await this.vaultIndexes(vaults);
    let qvec: string | null = null;
    if (this.dispatcher) qvec = vectorLiteral((await this.dispatcher.embed([(this.o.queryPrefix ?? "") + query], { priority: 0 })).vectors[0]!);
    const binVaults = qvec ? vaults.filter((v) => info.get(v)?.vectorIndex === "binary") : [];
    const fullVaults = qvec ? vaults.filter((v) => info.get(v)?.vectorIndex === "full") : [];
    const rows = await withReader(this.sql, { ...p, vaults }, (tx) =>
      this.query(tx, { q: query.trim(), qvec, vaults, binVaults, fullVaults, cand: opts.candidates ?? 200, typePrefixes: opts.types?.map((t) => `${t}%`) ?? null, includeSources: opts.includeSources ?? !opts.types, limit: opts.limit ?? 10 }, true),
    );
    return (rows as unknown as Record<string, string>[]).map((r) => r["QUERY PLAN"]!);
  }

  private async query(
    tx: TransactionSql,
    a: { q: string; qvec: string | null; vaults: string[]; binVaults: string[]; fullVaults: string[]; cand: number; typePrefixes: string[] | null; includeSources: boolean; limit: number },
    explain = false,
  ): Promise<Row[]> {
    const D = this.o.dims;
    if (a.qvec) {
      // Every partition runs its own HNSW scan and the results are merged: with many vaults
      // each one needs to contribute only a share of the candidates. ef_search is the cost
      // of each scan, so it scales down with the number of partitions (floor 40).
      const partitions = Math.max(1, a.binVaults.length + a.fullVaults.length);
      const ef = Math.max(40, Math.min(400, Math.ceil((a.cand * 2) / partitions)));
      await tx`select set_config('hnsw.ef_search', ${String(ef)}, true),
                     set_config('hnsw.iterative_scan', 'relaxed_order', true)`;
    }
    const vecQ = `$2::halfvec(${D})`;
    const sqlText = `
      with fts as (
        -- the tsquery must be written inline: taken from a joined subquery it is not an index
        -- condition, and Postgres scans every partition sequentially (phase 1 benchmark: 0.9 s)
        select c.vault_id, c.id,
               row_number() over (order by ts_rank_cd(c.tsv, websearch_to_tsquery('italian', $1) || websearch_to_tsquery('english', $1), 32) desc) as r
        from chunks c
        where c.vault_id = any($3)
          and c.tsv @@ (websearch_to_tsquery('italian', $1) || websearch_to_tsquery('english', $1))
        order by ts_rank_cd(c.tsv, websearch_to_tsquery('italian', $1) || websearch_to_tsquery('english', $1), 32) desc
        limit $6
      ),
      vbin as (
        select vault_id, id, ${vecExpr(D)} <=> ${vecQ} as d from (
          select c.vault_id, c.id, c.embedding from chunks c
          where c.vault_id = any($4) and $11 and c.embedding_model = $13
          order by ${binExpr(D).replaceAll("embedding", "c.embedding")} <~> binary_quantize(${vecQ})
          limit $6
        ) x
      ),
      vfull as (
        select c.vault_id, c.id, ${vecExpr(D).replaceAll("embedding", "c.embedding")} <=> ${vecQ} as d from chunks c
        where c.vault_id = any($5) and $11 and c.embedding_model = $13
        order by ${vecExpr(D).replaceAll("embedding", "c.embedding")} <=> ${vecQ}
        limit $6
      ),
      vec as (
        select vault_id, id, row_number() over (order by d) as r
        from (select * from vbin union all select * from vfull) v
        where d <= $12
        order by d limit $6
      ),
      titles as (
        select a.vault_id, a.page_id, max(similarity(a.alias_norm, $7)) as s
        from aliases a
        where a.vault_id = any($3) and a.alias_norm % $7
        group by a.vault_id, a.page_id
        order by s desc limit 20
      ),
      fused as (
        select vault_id, id, sum(1.0 / (${RRF_K} + r)) as score, bool_or(src = 'v') as has_vec
        from (select vault_id, id, r, 'f' as src from fts union all select vault_id, id, r, 'v' from vec) u
        group by vault_id, id
      ),
      ranked as (
        select f.*, c.page_id, c.source_id, c.heading, c.block_id, c.text
        from fused f join chunks c on c.vault_id = f.vault_id and c.id = f.id
        order by f.score desc
        limit $8
      )
      select r.vault_id, r.id, r.page_id, r.source_id, r.heading, r.block_id, r.text,
             (r.score + coalesce(t.s, 0) * 0.05)::float8 as score, r.has_vec,
             coalesce(p.title, s.name) as title, coalesce(p.type, 'source/' || s.mime) as type,
             coalesce(p.tldr, '') as tldr, coalesce(p.tokens, 0) as tokens,
             coalesce(p.classification, s.classification) as classification,
             (t.s is not null) as title_hit
      from ranked r
      left join pages p on p.id = r.page_id
      left join sources s on s.id = r.source_id
      left join titles t on t.vault_id = r.vault_id and t.page_id = r.page_id
      where (p.id is not null or s.id is not null)
        and ($9::text[] is null or (p.id is not null and p.type like any($9)))
        and ($10 or r.page_id is not null)
      union all
      -- pages that match only by title (no chunk in the top candidates)
      select t.vault_id, p.id || ':title', p.id, null, '', null, p.tldr,
             (t.s * 0.05)::float8 as score, false, p.title, p.type, p.tldr, p.tokens, p.classification, true
      from titles t join pages p on p.id = t.page_id
      where not exists (select 1 from ranked r where r.page_id = t.page_id)
        and ($9::text[] is null or p.type like any($9))`;
    return tx.unsafe<Row[]>((explain ? "explain (analyze, costs off, summary on) " : "") + sqlText, [
      a.q,
      a.qvec,
      a.vaults,
      a.binVaults,
      a.fullVaults,
      a.cand,
      normalizeTitle(a.q),
      Math.max(a.limit * 8, 50),
      a.typePrefixes,
      a.includeSources,
      a.qvec !== null,
      1 - (this.o.minVectorSimilarity ?? 0),
      // invariant 3: only vectors of the query's model are compared (a vault indexed by another
      // model, or with other dimensions, would make the cast to halfvec(D) fail)
      normalizeModelName(this.o.embedModel),
    ] as never[]);
    // Not prepared on purpose: Postgres switches prepared statements to a generic plan, and the
    // generic plan of this partitioned query was 2-3x slower in the phase 1 benchmark.
  }

  /** Groups chunk rows into page/source hits, with boosts and snippets. */
  private group(rows: Row[], q: string): SearchHit[] {
    const terms = queryTerms(q);
    const byKey = new Map<string, SearchHit>();
    for (const r of rows) {
      const kind = r.page_id ? "page" : "source";
      const id = (r.page_id ?? r.source_id)!;
      let h = byKey.get(id);
      if (!h) {
        h = {
          kind,
          id,
          vaultId: r.vault_id,
          title: r.title,
          type: r.type,
          tldr: r.tldr,
          level: kind === "page" ? "I3" : r.has_vec ? "I2" : "I1",
          classification: r.classification,
          tokens: kind === "page" ? r.tokens : 0,
          score: 0,
          cite: id,
          chunks: [],
          matchedTitle: false,
        };
        byKey.set(id, h);
      }
      h.matchedTitle ||= r.title_hit;
      if (!r.id.endsWith(":title")) {
        h.chunks.push({ id: r.id, heading: r.heading, blockId: r.block_id, snippet: snippet(r.text, terms), score: Number(r.score) });
        if (kind === "source") h.tokens += estimateTokens(r.text);
      }
      // A page collects the evidence of its chunks: best chunk + a share of the others.
      h.score = Math.max(h.score, Number(r.score)) + (h.chunks.length > 1 ? Number(r.score) * 0.25 : 0);
    }
    for (const h of byKey.values()) {
      h.chunks.sort((a, b) => b.score - a.score);
      h.chunks = h.chunks.slice(0, 3);
      if (h.chunks[0]?.blockId) h.cite = `${h.id}#${h.chunks[0].blockId}`;
      // Compiled pages are the preferred answer; raw sources remain the evidence.
      if (h.kind === "page") h.score *= 1.15;
      if (h.matchedTitle) h.score *= 1.1;
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score);
  }
}

/** Query words for snippets: lower case, no accents, 3+ characters, 5-letter prefixes (≈ stems). */
export function queryTerms(q: string): string[] {
  return [...new Set(normalizeTitle(q).split(" ").filter((w) => w.length >= 3).map((w) => w.slice(0, 5)))];
}

/** A ~240-character window around the densest group of query words; matches marked «...». */
export function snippet(text: string, terms: string[], width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width && terms.length === 0) return flat;
  const norm = flat.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const positions: number[] = [];
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu");
    for (const m of norm.matchAll(re)) positions.push(m.index!);
  }
  positions.sort((a, b) => a - b);
  let start = 0;
  if (positions.length) {
    let best = 0;
    let bestCount = 0;
    for (let i = 0; i < positions.length; i++) {
      let j = i;
      while (j < positions.length && positions[j]! - positions[i]! < width * 0.7) j++;
      if (j - i > bestCount) {
        bestCount = j - i;
        best = positions[i]!;
      }
    }
    start = Math.max(0, best - Math.floor(width * 0.2));
    const space = flat.lastIndexOf(" ", start);
    start = space > 0 && start - space < 20 ? space + 1 : start;
  }
  let out = flat.slice(start, start + width);
  if (start + width < flat.length) out = out.replace(/\s+\S*$/, "") + "…";
  if (start > 0) out = "…" + out;
  if (terms.length) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])((?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[\\p{L}\\p{N}]*)`, "giu");
    // match on the accent-free copy, mark on the original (same length after NFD folding of Latin text)
    const normOut = out.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (normOut.length === out.length) {
      let marked = "";
      let last = 0;
      for (const m of normOut.matchAll(re)) {
        marked += out.slice(last, m.index!) + "«" + out.slice(m.index!, m.index! + m[0].length) + "»";
        last = m.index! + m[0].length;
      }
      out = marked + out.slice(last);
    }
  }
  return out;
}
