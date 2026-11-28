# Phase 6 — Retrieval evaluation on the synthetic corpus (reranking 10 candidates)

Run `mvs56kgj` · 2026-10-28T13:31:58.069Z · corpus seed 42: 388 documents, 131 questions · 599 chunks, 43,169 tokens · models: chat up, local-embed up, local-rerank up, mock-chat up, mock-embed up, mock-rerank up

## Search (`brain_search`, top 5, hybrid + reranker, account with `interno` clearance)

| Metric | Value |
|---|---|
| recall@5 (at least one expected source in top 5) | **0.962** |
| hit@1 | 0.748 |
| MRR | 0.837 |
| Mean tokens per `brain_search` response | 857 |
| Median latency (cold cache) | 2673 ms |

| Question type | Questions | recall@5 | hit@1 |
|---|---|---|---|
| lookup | 61 | 0.951 | 0.623 |
| updated | 23 | 0.913 | 0.826 |
| decision | 19 | 1.000 | 0.789 |
| contradiction | 5 | 1.000 | 0.600 |
| relational | 23 | 1.000 | 1.000 |

## Classification

| Check | Result |
|---|---|
| `riservato` (confidential) canaries returned (targeted search + read by id) | 0 of 10 |
| Search responses containing items above `interno` (internal) | 0 of 131 |

## Local model answers (`brain_ask`)

| Metric | Value |
|---|---|
| Questions | 30 |
| Correct answers (expected value; for lists, at least 80% of items) | 90.0% |
| Citation precision (cited passage contains expected value or list item) | 57.9% (76 citations) |
| Citations to unprovided IDs | 0 |
| Mean model tokens per answer | 1438 |
| Mean time | 8.3 s |
| Intentional contradictions: answers reporting both values | 5 of 5 |
| Intentional contradictions: stated explicitly (discrepancy, conflict…) | 1 of 5 |

## Questions not found in the top 5

- q2 (updated) "How many Company example 5 seats does Tirrena Assicurazioni Group have?" — expected: `email/tirrena-assicurazioni-group/2025-08-08-00002.eml`; found: `analysis/2025-12-11-analisi-tecnica-progetto-iride.md`, `analysis/2025-07-30-analisi-tecnica-progetto-aurora.md`, `offers/2025-01-14-offerta-tirrena-assicurazioni-group.txt`
- q7 (lookup) "Who is the technical contact for Alpi Sanità S.p.A.?" — expected: `email/alpi-sanita-s-p-a/2025-05-31-00005.eml`; found: `analysis/2025-01-22-analisi-tecnica-progetto-cometa.md`, `minutes/2025-04-14-kickoff-progetto-borea.md`, `minutes/2025-01-10-kickoff-progetto-cometa.md`
- q13 (lookup) "Who is the technical contact for Ligure Costruzioni S.r.l.?" — expected: `email/ligure-costruzioni-s-r-l/2025-03-31-00007.eml`; found: `analysis/2025-02-05-analisi-tecnica-progetto-orione.md`, `minutes/2025-01-20-kickoff-progetto-orione.md`, `minutes/2025-07-18-kickoff-progetto-nettuno.md`
- q19 (lookup) "Who is the technical contact for Salentina Alimentare S.r.l.?" — expected: `email/salentina-alimentare-s-r-l/2025-06-30-00010.eml`; found: `email/salentina-costruzioni-group/2026-03-03-00013.eml`, `minutes/2025-09-11-kickoff-progetto-sirio.md`, `minutes/2025-10-27-kickoff-progetto-quarzo.md`
- q23 (updated) "How many Company example 5 seats does Salentina Costruzioni Group have?" — expected: `email/salentina-costruzioni-group/2026-01-01-00012.eml`; found: `analysis/2025-03-08-analisi-tecnica-progetto-delta.md`, `analysis/2025-09-14-analisi-tecnica-progetto-vela.md`, `email/salentina-costruzioni-group/2025-06-22-00011.eml`
