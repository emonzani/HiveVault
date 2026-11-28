# Compilation benchmark (M13)

2026-11-11T13:28:39.795Z · model `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` · 20 documents from corpus `data/corpus/dev` · compiled one source at a time

| Metric | Value |
|---|---|
| Sources compiled / failed | 20 / 0 |
| Seconds per source (mean, p50, p90) | 174 · 161 · 279 |
| Agent turns per source | 4.7 |
| Tokens per source (prompt, completion) | 31,306 · 8,032 |
| Source text tokens (mean) | 166 |
| Completion tokens per second | 46.1 |
| Pages written per source · rejected writes | 5.9 · 0.0 |
| Sources per hour | 20.7 |
| Hours per 1,000 sources | 48.4 |
| Expected answers in model-written pages (top 5) | 25/26 |
| … "lookup" questions | 18/19 |
| … "updated" questions | 7/7 |

Per-source data: `bench/out/compile-mwc3kbiv.json`.
