# Benchmark della compilazione (M13)

2026-11-11T13:28:39.795Z · modello `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` · 20 documenti del corpus `data/corpus/dev` · compilazione una sorgente alla volta

| Misura | Valore |
|---|---|
| Sorgenti compilate / fallite | 20 / 0 |
| Secondi per sorgente (media, p50, p90) | 174 · 161 · 279 |
| Turni dell'agente per sorgente | 4,7 |
| Token per sorgente (prompt, risposta) | 31.306 · 8032 |
| Token di testo della sorgente (media) | 166 |
| Token di risposta al secondo | 46,1 |
| Pagine scritte per sorgente · scritture rifiutate | 5,9 · 0,0 |
| Sorgenti all'ora | 20,7 |
| Ore per 1.000 sorgenti | 48,4 |
| Risposte attese nelle pagine del modello (top 5) | 25/26 |
| … domande «lookup» | 18/19 |
| … domande «updated» | 7/7 |

Dati per sorgente: `bench/out/compile-mwc3kbiv.json`.
