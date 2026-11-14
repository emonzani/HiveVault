# Fase 6 — eval di recupero sul corpus sintetico (riordino di 10 candidati)

Run `mvs56kgj` · 2026-10-28T13:31:58.069Z · corpus seed 42: 388 documenti, 131 domande · 599 chunk, 43.169 token · modelli: chat up, local-embed up, local-rerank up, mock-chat up, mock-embed up, mock-rerank up

## Ricerca (brain_search, top 5, ibrida + reranker, account con clearance interno)

| Misura | Valore |
|---|---|
| recall@5 (almeno una fonte attesa tra i primi 5) | **0.962** |
| hit@1 | 0.748 |
| MRR | 0.837 |
| Token medi per risposta di brain_search | 857 |
| Latenza mediana (cache fredda) | 2673 ms |

| Tipo di domanda | Domande | recall@5 | hit@1 |
|---|---|---|---|
| lookup | 61 | 0.951 | 0.623 |
| updated | 23 | 0.913 | 0.826 |
| decision | 19 | 1.000 | 0.789 |
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
| Risposte corrette (il valore atteso; per gli elenchi almeno l'80% degli elementi) | 90,0% |
| Precisione delle citazioni (il passo citato contiene il valore atteso o un elemento dell'elenco) | 57,9% (76 citazioni) |
| Citazioni a id non forniti | 0 |
| Token medi del modello per risposta | 1438 |
| Tempo medio | 8,3 s |
| Contraddizioni volute: risposte con entrambi i valori | 5 su 5 |
| Contraddizioni volute: dette esplicitamente (discordanza, conflitto…) | 1 su 5 |

## Domande non trovate nei primi 5

- q2 (updated) «Quante postazioni di Company example 5 ha Tirrena Assicurazioni Group?» — attese: email/tirrena-assicurazioni-group/2025-08-08-00002.eml; trovate: analysis/2025-12-11-analisi-tecnica-progetto-iride.md, analysis/2025-07-30-analisi-tecnica-progetto-aurora.md, offers/2025-01-14-offerta-tirrena-assicurazioni-group.txt
- q7 (lookup) «Chi è il referente tecnico di Alpi Sanità S.p.A.?» — attese: email/alpi-sanita-s-p-a/2025-05-31-00005.eml; trovate: analysis/2025-01-22-analisi-tecnica-progetto-cometa.md, minutes/2025-04-14-kickoff-progetto-borea.md, minutes/2025-01-10-kickoff-progetto-cometa.md
- q13 (lookup) «Chi è il referente tecnico di Ligure Costruzioni S.r.l.?» — attese: email/ligure-costruzioni-s-r-l/2025-03-31-00007.eml; trovate: analysis/2025-02-05-analisi-tecnica-progetto-orione.md, minutes/2025-01-20-kickoff-progetto-orione.md, minutes/2025-07-18-kickoff-progetto-nettuno.md
- q19 (lookup) «Chi è il referente tecnico di Salentina Alimentare S.r.l.?» — attese: email/salentina-alimentare-s-r-l/2025-06-30-00010.eml; trovate: email/salentina-costruzioni-group/2026-03-03-00013.eml, minutes/2025-09-11-kickoff-progetto-sirio.md, minutes/2025-10-27-kickoff-progetto-quarzo.md
- q23 (updated) «Quante postazioni di Company example 5 ha Salentina Costruzioni Group?» — attese: email/salentina-costruzioni-group/2026-01-01-00012.eml; trovate: analysis/2025-03-08-analisi-tecnica-progetto-delta.md, analysis/2025-09-14-analisi-tecnica-progetto-vela.md, email/salentina-costruzioni-group/2025-06-22-00011.eml
