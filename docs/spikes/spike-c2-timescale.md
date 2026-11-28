# Spike C2 — Vectors: pgvector binary HNSW vs pgvectorscale DiskANN

2026-10-27T16:48:59.442Z · vector 0.8.7, vectorscale 0.9.1 · 1,000,000 1024-dim vectors · 20 vaults in a single table

- Load: 24,527 rows/s
- pgvector binary HNSW: build 35 s, 0.40 GB
- DiskANN (SBQ, `memory_optimized`): build 1,401 s, 0.54 GB
- DiskANN with labels (vault as label): build aborted after 36 minutes at 35% (estimated ~1 h 45 min for 1M vectors). Not measured: build cost rules it out for TB scale.

| Index | 3 vaults p50/p95/p99 ms | 20 vaults p50/p95/p99 ms | recall@10 (3 / 20 vaults) |
|---|---|---|---|
| pgvector binary HNSW + rescoring 200 | 21.2 / 26.4 / 30.7 | 6.0 / 7.6 / 8.7 | 92.5% / 76.3% |
| DiskANN (rescore 200) | 11.0 / 21.8 / 33.5 | 8.3 / 10.3 / 11.1 | 92.3% / 89.8% |

Latencies from the Node client, 200 queries after 20 warm-up queries. Each variant runs with the other two indexes dropped inside the same transaction (rolled back at the end), so the planner cannot pick another index.
