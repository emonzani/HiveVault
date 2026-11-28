# Phase 1 — Query engine benchmark

2026-10-27T18:08:41.721Z · 1,000,000 source chunks + 1,000 compiled pages · 20 vaults · `halfvec(1024)`, binary index + rescoring · minimal vocabulary, 60 words (worst case for full-text)

- Bulk load: 18,864 chunks/s (binary COPY, 8 streams, without vector index)
- Binary index build (20 partitions): 74 s
- Page writes with PageStore: 76 pages/s (aliases, blocks, links, chunks; embeddings not computed)
- Chunk storage (tables + indexes): 5.20 GB

| Operation (full engine) | p50 / p95 / p99 ms | Notes |
|---|---|---|
| Hybrid search, 3 vaults | 26.3 / 31.8 / 38.1 | 10.0 results on average |
| Hybrid search, 20 vaults | 60.6 / 85.4 / 132.9 | 10.0 results on average |
| Budgeted page read (800 tokens) | 3.6 / 4.3 / 5.9 | |
| Title search, pages only | 43.6 / 48.7 / 53.3 | filter `type = entity` |
| Repeated search (cache) | 0.7 / 0.9 / 5.5 | key = vault versions |

Most expensive statements during 40 searches across 20 vaults (`pg_stat_statements`):

| Calls | Mean ms | Statement |
|---|---|---|
| 60 | 52.6 | `with fts as ( -- the tsquery must be written inline: taken from a joined subquery it is no…` |
| 60 | 0.0 | `select id, version from vaults where id = any($1) order by id…` |
| 60 | 0.0 | `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'relaxed_…` |
| 60 | 0.0 | `select set_config('cb.vaults', $1, true), set_config('cb.clearance', $2, true)…` |
| 60 | 0.0 | `begin…` |

Plan targets (§0.2): hybrid search p95 < 200 ms on allowed spaces, page read p95 < 20 ms.
