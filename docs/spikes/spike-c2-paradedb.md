# Spike C2 — Full-text: `tsvector` vs ParadeDB

2026-10-27T16:42:33.522Z · ParadeDB `pg_search` 0.26.3 · 1,000,000 chunks (~700 characters, long-tail vocabulary) · 20 vaults in a single table

- Load: 32,385 rows/s
- GIN on `tsvector`: build 3 s, 0.09 GB
- ParadeDB index: build 15 s, 0.21 GB — `using paradedb (id, vault_id, (text::pdb.simple('stemmer=italian')))`

| Query (top 200) | Type | 3 vaults | 20 vaults |
|---|---|---|---|
| tsvector AND (websearch) + ts_rank_cd | rare | 1.2 / 3.9 / 26.2 | 1.2 / 5.5 / 23.9 |
| tsvector OR + ts_rank_cd | rare | 96.4 / 275.9 / 294.2 | 192.8 / 657.0 / 698.6 |
| ParadeDB OR (`\|\|\|`) + BM25 | rare | 3.8 / 5.4 / 5.7 | 4.9 / 22.5 / 23.7 |
| tsvector AND (websearch) + ts_rank_cd | common | 6.3 / 11.9 / 34.9 | 7.7 / 18.0 / 68.6 |
| tsvector OR + ts_rank_cd | common | 190.1 / 342.8 / 399.2 | 483.7 / 989.5 / 1205.9 |
| ParadeDB OR (`\|\|\|`) + BM25 | common | 3.5 / 4.2 / 4.6 | 21.7 / 22.8 / 24.7 |

- Top-10 overlap (`ts_rank_cd` OR vs BM25): 16% — the two rankings differ by design (BM25 weights term rarity).

Latencies p50 / p95 / p99 in ms from the Node client, 200 queries per cell after 20 warm-up queries.
