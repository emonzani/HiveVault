# Spike C — PostgreSQL + pgvector at scale

2026-10-27T13:50:10.895Z · PostgreSQL 17 + pgvector 0.8 (Docker, VM 32 GB, shared_buffers 8 GB) · 20 vault partitions · halfvec(1024) · 4096 topics · chunks ≈ 700 characters

Latency columns: p50 / p95 / p99 in ms, measured from the Node client (200 queries after 20 warm-up). ACL "3 vault" = 3 of 20 vaults allowed (partition pruning); "tutti" = all vaults.


## 1.0M chunks

- Load: already present
- HNSW halfvec(1024) build (m=16, ef_construction=64): 134 s
- Size: heap+toast 4.12 GB · btree:chunks_pkey 0.03 GB · gin:chunks_tsv_gin 0.08 GB · hnsw:chunks_emb_hnsw 2.54 GB · total 6.77 GB

| Query | ACL 3 vault | ACL tutti |
|---|---|---|
| Full-text (GIN, ts_rank_cd, top 50) | 2.1 / 5.3 / 15.7 | 9.6 / 33.5 / 86.7 |
| Vettori HNSW ef_search=40 | 6.4 / 7.6 / 8.4 | 29.4 / 35.4 / 38.3 |
| Vettori HNSW ef_search=100 | 9.6 / 10.8 / 11.2 | 52.8 / 56.6 / 60.3 |
| Ibrida RRF (FTS 200 + HNSW 200, ef=40) | 8.2 / 10.7 / 18.7 | 39.6 / 69.0 / 87.9 |

- HNSW recall@10 vs exact search: ef=40 → 99.3% (tutti) / 98.3% (3 vault); ef=100 → 100.0% (tutti)

### Variants at this size

- halfvec(512): column fill 1059 s, HNSW build 94 s, index 1.27 GB
- binary_quantize bit(1024): HNSW build 59 s, index 0.40 GB

| Variant | ACL 3 vault | ACL tutti | recall@10 (tutti) |
|---|---|---|---|
| halfvec(1024) ef=40 (reference) | 8.0 / 11.6 / 18.5 | 31.7 / 54.5 / 65.1 | 99.3% |
| halfvec(512) ef=40 | 5.6 / 7.0 / 8.0 | 25.7 / 28.4 / 30.1 | 38.7% (vs 1024-d exact) |
| binary + rescoring (top 200, ef=200) | 9.6 / 10.8 / 11.3 | 61.7 / 65.3 / 68.0 | 96.7% |

## 2.0M chunks

- Load: 2146 rows/s (8 parallel binary COPY streams, HNSW and GIN maintained during the load)
- Size: heap+toast 9.26 GB · btree:chunks_pkey 0.09 GB · gin:chunks_tsv_gin 0.28 GB · hnsw:chunks_emb_hnsw 5.09 GB · total 14.71 GB

| Query | ACL 3 vault | ACL tutti |
|---|---|---|
| Full-text (GIN, ts_rank_cd, top 50) | 5.0 / 19.3 / 37.0 | 31.1 / 63.6 / 131.7 |
| Vettori HNSW ef_search=40 | 9.1 / 12.0 / 12.7 | 32.0 / 38.3 / 40.7 |
| Vettori HNSW ef_search=100 | 12.4 / 15.9 / 18.9 | 54.6 / 59.7 / 62.4 |
| Ibrida RRF (FTS 200 + HNSW 200, ef=40) | 14.7 / 24.2 / 31.0 | 63.8 / 94.0 / 102.1 |

- HNSW recall@10 vs exact search: ef=40 → 99.3% (tutti) / 99.3% (3 vault); ef=100 → 99.7% (tutti)

## 5.0M chunks

- Load: 917 rows/s (8 parallel binary COPY streams, HNSW and GIN maintained during the load)
- Size: heap+toast 21.30 GB · btree:chunks_pkey 0.18 GB · gin:chunks_tsv_gin 0.52 GB · hnsw:chunks_emb_hnsw 12.71 GB · total 34.72 GB

| Query | ACL 3 vault | ACL tutti |
|---|---|---|
| Full-text (GIN, ts_rank_cd, top 50) | 26.2 / 132.2 / 416.0 | 193.1 / 1070.9 / 2644.9 |
| Vettori HNSW ef_search=40 | 32.5 / 69.4 / 83.6 | 357.6 / 885.8 / 5082.1 |
| Vettori HNSW ef_search=100 | 25.9 / 77.8 / 99.6 | 241.6 / 660.6 / 850.3 |
| Ibrida RRF (FTS 200 + HNSW 200, ef=40) | 52.6 / 144.6 / 302.3 | 480.3 / 1560.1 / 2589.2 |

- HNSW recall@10 vs exact search: ef=40 → 93.3% (tutti) / 90.7% (3 vault); ef=100 → 97.7% (tutti)
