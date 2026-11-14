# Fase 3 — compilazione con crash dei worker

Run `14zqzk` · 2026-10-27T19:16:46.534Z · 60 sorgenti caricate (12 figli da ZIP) · 2 processi worker · SIGKILL ogni 1500 ms · modello a copione lento (150 ms per turno, 4 turni per sorgente)

| Controllo | Risultato |
|---|---|
| Sorgenti (con i figli) | 72 |
| Processi worker uccisi | 7 |
| Task ripresi dopo la scadenza del lease | 33 |
| Sorgenti non compilate | nessuna |
| Pagine sorgente: mancanti / duplicate | 0 / 0 |
| Pagine di entità per sorgente (attese 72) | 72 |
| Pagine con titolo duplicato | nessuna |
| Pagina condivisa "Cliente comune": copie / versioni | 1 / 85 |
| Task non conclusi | 0 |
| Tempo totale | 11.8 s |

**Esito: SUPERATO** — nessuna sorgente persa, nessuna pagina duplicata.
