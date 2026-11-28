# Phase 1 — Query engine benchmark

2026-10-27T18:05:49.890Z · 1,000,000 source chunks + 1,000 compiled pages · 20 vaults · `halfvec(1024)`, binary index + rescoring · long-tail vocabulary (half of the queries include a rare term)

- Bulk load: 19,729 chunks/s (binary COPY, 8 streams, without vector index)
- Binary index build (20 partitions): 77 s
- Page writes with PageStore: 82 pages/s (aliases, blocks, links, chunks; embeddings not computed)
- Chunk storage (tables + indexes): 5.36 GB

| Operation (full engine) | p50 / p95 / p99 ms | Notes |
|---|---|---|
| Hybrid search, 3 vaults | 24.6 / 30.5 / 39.0 | 10.0 results on average |
| Hybrid search, 20 vaults | 54.8 / 86.5 / 179.1 | 10.0 results on average |
| Budgeted page read (800 tokens) | 3.6 / 4.5 / 6.0 | |
| Title search, pages only | 44.7 / 49.4 / 51.7 | filter `type = entity` |
| Repeated search (cache) | 0.7 / 1.3 / 2.3 | key = vault versions |

Most expensive statements during 40 searches across 20 vaults (`pg_stat_statements`):

| Calls | Mean ms | Statement |
|---|---|---|
| 60 | 46.1 | `with fts as ( -- the tsquery must be written inline: taken from a joined subquery it is no…` |
| 60 | 0.0 | `select id, version from vaults where id = any($1) order by id…` |
| 60 | 0.0 | `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'relaxed_…` |
| 60 | 0.0 | `select set_config('cb.vaults', $1, true), set_config('cb.clearance', $2, true)…` |
| 60 | 0.0 | `begin…` |

Plan targets (§0.2): hybrid search p95 < 200 ms on allowed spaces, page read p95 < 20 ms.
