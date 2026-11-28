# Phase 6 — Retrieval evaluation on the synthetic corpus (reranking 20 candidates, first-version `brain_ask` scoring)

Run `mvs4gdnn` · 2026-10-28T13:19:16.854Z · corpus seed 42: 388 documents, 131 questions · 599 chunks, 43,160 tokens · models: chat up, local-embed up, local-rerank up, mock-chat up, mock-embed up, mock-rerank up

## Search (`brain_search`, top 5, hybrid + reranker, account with `interno` clearance)

| Metric | Value |
|---|---|
| recall@5 (at least one expected source in top 5) | **0.992** |
| hit@1 | 0.733 |
| MRR | 0.833 |
| Mean tokens per `brain_search` response | 838 |
| Median latency (cold cache) | 5311 ms |

| Question type | Questions | recall@5 | hit@1 |
|---|---|---|---|
| lookup | 61 | 1.000 | 0.607 |
| updated | 23 | 1.000 | 0.826 |
| decision | 19 | 0.947 | 0.737 |
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
| Correct answers (contain the expected value) | 70.0% |
| Citation precision (cited passage contains the expected value) | 41.3% (75 citations) |
| Citations to unprovided IDs | 0 |
| Mean model tokens per answer | 1388 |
| Mean time | 11.0 s |
| Intentional contradictions flagged | 1 of 5 (both values cited: 5) |

## Questions not found in the top 5

- q101 (decision) "Which database does Progetto Iride 2 use and why?" — expected: `analysis/2025-01-20-analisi-tecnica-progetto-iride-2.md`; found: `analysis/2026-01-25-revisione-database-progetto-iride.md`, `analysis/2025-12-11-analisi-tecnica-progetto-iride.md`, `minutes/2025-01-04-kickoff-progetto-iride-2.md`
