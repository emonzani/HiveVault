# Benchmark della compilazione (M13)

2026-11-11T17:54:16.334Z · modello `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf` · modalità `extract` · 20 documenti del corpus `data/corpus/dev` · compilazione una sorgente alla volta

| Misura | Valore |
|---|---|
| Sorgenti compilate / fallite | 20 / 0 |
| Secondi per sorgente (media, p50, p90) | 11 · 11 · 13 |
| Turni dell'agente per sorgente | 1,0 |
| Token per sorgente (prompt, risposta) | 790 · 543 |
| Token di testo della sorgente (media) | 166 |
| Token di risposta al secondo | 51,6 |
| Pagine scritte per sorgente · scritture rifiutate | 2,3 · 0,0 |
| Sorgenti all'ora | 342,4 |
| Ore per 1.000 sorgenti | 2,9 |
| Risposte attese nelle pagine del modello (top 5) | 25/26 |
| … domande «lookup» | 19/19 |
| … domande «updated» | 6/7 |

Dati per sorgente: `bench/out/compile-mwcf038m.json`.
