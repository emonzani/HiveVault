# Compilation benchmark (M13)

2026-11-11T17:54:16.334Z · model `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` · mode `extract` · 20 documents from corpus `data/corpus/dev` · compiled one source at a time

| Metric | Value |
|---|---|
| Sources compiled / failed | 20 / 0 |
| Seconds per source (mean, p50, p90) | 11 · 11 · 13 |
| Agent turns per source | 1.0 |
| Tokens per source (prompt, completion) | 790 · 543 |
| Source text tokens (mean) | 166 |
| Completion tokens per second | 51.6 |
| Pages written per source · rejected writes | 2.3 · 0.0 |
| Sources per hour | 342.4 |
| Hours per 1,000 sources | 2.9 |
| Expected answers in model-written pages (top 5) | 25/26 |
| … "lookup" questions | 19/19 |
| … "updated" questions | 6/7 |

Per-source data: `bench/out/compile-mwcf038m.json`.
