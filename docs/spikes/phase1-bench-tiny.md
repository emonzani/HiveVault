# Fase 1 — benchmark del query engine

2026-10-27T18:08:41.721Z · 1.000.000 chunk di sorgenti + 1000 pagine compilate · 20 vault · halfvec(1024), indice binario + rescoring · vocabolario minimo, 60 parole (caso peggiore per il full-text)

- Caricamento: 18864 chunk/s (COPY binario, 8 flussi, senza indice vettoriale)
- Costruzione indice binario (20 partizioni): 74 s
- Scrittura pagine con PageStore: 76 pagine/s (alias, blocchi, link, chunk; embedding non calcolati)
- Spazio dei chunk (tabelle + indici): 5.20 GB

| Operazione (motore completo) | p50 / p95 / p99 ms | Note |
|---|---|---|
| Ricerca ibrida, 3 vault | 26.3 / 31.8 / 38.1 | 10.0 risultati in media |
| Ricerca ibrida, 20 vault | 60.6 / 85.4 / 132.9 | 10.0 risultati in media |
| Lettura pagina con budget (800 token) | 3.6 / 4.3 / 5.9 | |
| Ricerca per titolo, solo pagine | 43.6 / 48.7 / 53.3 | filtro type = entity |
| Ricerca ripetuta (cache) | 0.7 / 0.9 / 5.5 | chiave = versioni dei vault |

Statement più costosi durante 40 ricerche su 20 vault (pg_stat_statements):

| Chiamate | Media ms | Statement |
|---|---|---|
| 60 | 52.6 | `with fts as ( -- the tsquery must be written inline: taken from a joined subquery it is no…` |
| 60 | 0.0 | `select id, version from vaults where id = any($1) order by id…` |
| 60 | 0.0 | `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'relaxed_…` |
| 60 | 0.0 | `select set_config('cb.vaults', $1, true), set_config('cb.clearance', $2, true)…` |
| 60 | 0.0 | `begin…` |

Obiettivi del piano (§0.2): ricerca ibrida p95 < 200 ms sugli spazi consentiti, lettura pagina p95 < 20 ms.
