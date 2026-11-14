# Spike C2 — vettori: pgvector HNSW binario vs pgvectorscale DiskANN

2026-10-27T16:48:59.442Z · vector 0.8.7, vectorscale 0.9.1 · 1.000.000 vettori 1024 dim · 20 vault in una tabella

- Caricamento: 24527 righe/s
- pgvector HNSW binario: build 35 s, 0.40 GB
- DiskANN (SBQ, memory_optimized): build 1401 s, 0.54 GB
- DiskANN con etichette (vault come label): build interrotta dopo 36 minuti al 35% (stima ~1 h 45 min per 1M vettori). Non misurata: il costo di build la esclude per la scala TB.

| Indice | 3 vault p50/p95/p99 ms | 20 vault p50/p95/p99 ms | recall@10 (3 / 20 vault) |
|---|---|---|---|
| pgvector HNSW binario + rescoring 200 | 21.2 / 26.4 / 30.7 | 6.0 / 7.6 / 8.7 | 92.5% / 76.3% |
| DiskANN (rescore 200) | 11.0 / 21.8 / 33.5 | 8.3 / 10.3 / 11.1 | 92.3% / 89.8% |

Latenze dal client Node, 200 query dopo 20 di riscaldamento. Ogni variante gira con le altre due indici rimossi nella stessa transazione (rollback alla fine), così il planner non può scegliere un altro indice.
