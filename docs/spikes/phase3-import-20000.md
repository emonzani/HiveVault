# Fase 3 — import massivo di 20.000 file

Run `jd7yy6` · 2026-10-27T19:38:19.209Z · 2 processi worker × 8 task · file di testo da ~80 byte in cartelle da 1000

| Misura | Valore |
|---|---|
| Generazione dei file (una volta) | 0 s |
| Scansione | 1 s (20.000 file) |
| Memorizzazione (lettura, cifratura, sorgente, task) | 534.9 file/s |
| File salvati / duplicati / saltati / errori | 20000 / 0 / 0 / 0 |
| Sorgenti indicizzate (I1+) alla fine della misura | 20.000 |
| Durata della misura | 1.2 min |
| Spazio nel database (import_files, sources, tasks, eventi, chunk) | 355 MB |
| Coerenza dell'avanzamento | OK (salvati crescenti, somme corrette) |

## Avanzamento campionato

| t (s) | Stato | Salvati | In attesa | File/s | ETA (s) | Indicizzati |
|---|---|---|---|---|---|---|
| 10 | running | 4500 | 15500 | 574.9 | 27 | 1890 |
| 20 | running | 10000 | 10000 | 563.6 | 18 | 4118 |
| 30 | running | 15500 | 4500 | 548.8 | 8 | 6326 |
| 40 | done | 20000 | 0 | 534.9 | 0 | 8719 |
| 50 | done | 20000 | 0 | 534.9 | 0 | 12870 |
| 60 | done | 20000 | 0 | 534.9 | 0 | 16913 |
| 70 | done | 20000 | 0 | 534.9 | 0 | 20000 |
