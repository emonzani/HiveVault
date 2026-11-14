# Fase 1 — benchmark del query engine

2026-10-27T18:05:49.890Z · 1.000.000 chunk di sorgenti + 1000 pagine compilate · 20 vault · halfvec(1024), indice binario + rescoring · vocabolario a coda lunga (metà delle query con un termine raro)

- Caricamento: 19729 chunk/s (COPY binario, 8 flussi, senza indice vettoriale)
- Costruzione indice binario (20 partizioni): 77 s
- Scrittura pagine con PageStore: 82 pagine/s (alias, blocchi, link, chunk; embedding non calcolati)
- Spazio dei chunk (tabelle + indici): 5.36 GB

| Operazione (motore completo) | p50 / p95 / p99 ms | Note |
|---|---|---|
| Ricerca ibrida, 3 vault | 24.6 / 30.5 / 39.0 | 10.0 risultati in media |
| Ricerca ibrida, 20 vault | 54.8 / 86.5 / 179.1 | 10.0 risultati in media |
| Lettura pagina con budget (800 token) | 3.6 / 4.5 / 6.0 | |
| Ricerca per titolo, solo pagine | 44.7 / 49.4 / 51.7 | filtro type = entity |
| Ricerca ripetuta (cache) | 0.7 / 1.3 / 2.3 | chiave = versioni dei vault |

Statement più costosi durante 40 ricerche su 20 vault (pg_stat_statements):

| Chiamate | Media ms | Statement |
|---|---|---|
| 60 | 46.1 | `with fts as ( -- the tsquery must be written inline: taken from a joined subquery it is no…` |
| 60 | 0.0 | `select id, version from vaults where id = any($1) order by id…` |
| 60 | 0.0 | `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'relaxed_…` |
| 60 | 0.0 | `select set_config('cb.vaults', $1, true), set_config('cb.clearance', $2, true)…` |
| 60 | 0.0 | `begin…` |

Obiettivi del piano (§0.2): ricerca ibrida p95 < 200 ms sugli spazi consentiti, lettura pagina p95 < 20 ms.
