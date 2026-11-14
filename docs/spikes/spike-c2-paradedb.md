# Spike C2 — full-text: tsvector vs ParadeDB

2026-10-27T16:42:33.522Z · ParadeDB pg_search 0.26.3 · 1.000.000 chunk (~700 caratteri, vocabolario a coda lunga) · 20 vault in una tabella

- Caricamento: 32385 righe/s
- GIN su tsvector: build 3 s, 0.09 GB
- Indice ParadeDB: build 15 s, 0.21 GB — `using paradedb (id, vault_id, (text::pdb.simple('stemmer=italian')))`

| Query (top 200) | Tipo | 3 vault | 20 vault |
|---|---|---|---|
| tsvector AND (websearch) + ts_rank_cd | rare | 1.2 / 3.9 / 26.2 | 1.2 / 5.5 / 23.9 |
| tsvector OR + ts_rank_cd | rare | 96.4 / 275.9 / 294.2 | 192.8 / 657.0 / 698.6 |
| ParadeDB OR (`|||`) + BM25 | rare | 3.8 / 5.4 / 5.7 | 4.9 / 22.5 / 23.7 |
| tsvector AND (websearch) + ts_rank_cd | common | 6.3 / 11.9 / 34.9 | 7.7 / 18.0 / 68.6 |
| tsvector OR + ts_rank_cd | common | 190.1 / 342.8 / 399.2 | 483.7 / 989.5 / 1205.9 |
| ParadeDB OR (`|||`) + BM25 | common | 3.5 / 4.2 / 4.6 | 21.7 / 22.8 / 24.7 |

- Sovrapposizione dei primi 10 (ts_rank_cd OR vs BM25): 16% — i due ranking sono diversi per costruzione (BM25 pesa la rarità dei termini).

Latenze p50 / p95 / p99 in ms dal client Node, 200 query per cella dopo 20 di riscaldamento.
