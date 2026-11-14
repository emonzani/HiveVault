# Fase 6 — eval di recupero sul corpus sintetico (riordino di 20 candidati, punteggio di brain_ask della prima versione)

Run `mvs4gdnn` · 2026-10-28T13:19:16.854Z · corpus seed 42: 388 documenti, 131 domande · 599 chunk, 43.160 token · modelli: chat up, local-embed up, local-rerank up, mock-chat up, mock-embed up, mock-rerank up

## Ricerca (brain_search, top 5, ibrida + reranker, account con clearance interno)

| Misura | Valore |
|---|---|
| recall@5 (almeno una fonte attesa tra i primi 5) | **0.992** |
| hit@1 | 0.733 |
| MRR | 0.833 |
| Token medi per risposta di brain_search | 838 |
| Latenza mediana (cache fredda) | 5311 ms |

| Tipo di domanda | Domande | recall@5 | hit@1 |
|---|---|---|---|
| lookup | 61 | 1.000 | 0.607 |
| updated | 23 | 1.000 | 0.826 |
| decision | 19 | 0.947 | 0.737 |
| contradiction | 5 | 1.000 | 0.600 |
| relational | 23 | 1.000 | 1.000 |

## Classificazione

| Controllo | Esito |
|---|---|
| Canarini «riservato» restituiti (ricerca mirata + lettura per id) | 0 su 10 |
| Risposte di ricerca con elementi sopra «interno» | 0 su 131 |

## Risposte del modello locale (brain_ask)

| Misura | Valore |
|---|---|
| Domande | 30 |
| Risposte corrette (contengono il valore atteso) | 70,0% |
| Precisione delle citazioni (il passo citato contiene il valore atteso) | 41,3% (75 citazioni) |
| Citazioni a id non forniti | 0 |
| Token medi del modello per risposta | 1388 |
| Tempo medio | 11,0 s |
| Contraddizioni volute segnalate | 1 su 5 (entrambi i valori citati: 5) |

## Domande non trovate nei primi 5

- q101 (decision) «Quale database usa il Progetto Iride 2 e perché?» — attese: analysis/2025-01-20-analisi-tecnica-progetto-iride-2.md; trovate: analysis/2026-01-25-revisione-database-progetto-iride.md, analysis/2025-12-11-analisi-tecnica-progetto-iride.md, minutes/2025-01-04-kickoff-progetto-iride-2.md
