# Checklist di rilascio

Completa ogni voce prima di mettere HiveVault in produzione e prima di ogni aggiornamento maggiore. Le voci con **[S]** sono di sviluppo: la squadra le verifica sul codice. Le voci con **[I]** sono di installazione: l'operatore le verifica sul server di produzione.

Stato: verifica di sviluppo del 2026-11-02 (fase 8). Le voci **[I]** restano da fare a ogni installazione.

## 1. Qualità del codice [S]

| # | Voce | Comando o prova | Esito |
|---|---|---|---|
| 1.1 | Controllo dei tipi di tutti i pacchetti | `npm run lint` | ✅ |
| 1.2 | Controllo dei tipi dell'interfaccia | `npm run check -w @cb/web` | ✅ |
| 1.3 | Test unitari e di database | `npm test` | ✅ (vedi il rapporto della fase 8) |
| 1.4 | Test end-to-end nei 4 temi, con axe WCAG 2.1 AA | `npm run e2e` | ✅ |
| 1.5 | Dipendenze di produzione senza vulnerabilità alte o critiche | `npm audit --omit=dev` | ✅ 0 alte; moderate non raggiungibili, motivate in [asvs-l2.md](sicurezza/asvs-l2.md#v10--codice-malevolo-e-dipendenze) |
| 1.6 | Nessun segreto nel repository | `git grep -nE "BEGIN [A-Z ]*PRIVATE KEY|cb_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}" -- . ':(exclude)package-lock.json'` vuoto; `.env`, `data/`, `bench/out/` ignorati. Le chiavi dei test del login con firma non sono nel repository: `packages/auth/test/fixtures/generate.ts` le crea con OpenSSL prima dei test | ✅ |

## 2. Sicurezza [S]

| # | Voce | Prova | Esito |
|---|---|---|---|
| 2.1 | Revisione OWASP ASVS 4.0.3 livello 2 | [docs/sicurezza/asvs-l2.md](sicurezza/asvs-l2.md) | ✅ 7 problemi trovati e corretti; voci aperte solo di installazione |
| 2.2 | I documenti non escono dalla rete | Egress guard, endpoint dei modelli solo privati (test) | ✅ |
| 2.3 | L'agente cloud non legge oltre «interno» | `mcp.e2e.test.ts`, eval della fase 6 | ✅ |
| 2.4 | Header di sicurezza e `no-store` sull'API | `workspace.e2e.test.ts` | ✅ |

## 3. Prestazioni [S]

| # | Voce | Obiettivo (piano §0.2) | Esito |
|---|---|---|---|
| 3.1 | Ricerca ibrida senza rerank sotto carico | p95 < 200 ms | ✅ 153 ms (ricerche fuori dalla cache, 40 utenti, k6) |
| 3.2 | Lettura di una pagina con budget | p95 < 20 ms | ✅ 14 ms (3.225 letture, 40 utenti) |
| 3.3 | Dashboard con 7 giorni di dati al minuto | fluide | ✅ mediana peggiore 129 ms (fase 7) |
| 3.4 | Query più lente profilate | `pg_stat_statements`, `EXPLAIN ANALYZE` | ✅ Inbox e «Da rivedere» da 95/77 ms a 0,15/0,02 ms (migrazione 012); ricerca filtrata per modello di embedding |

## 4. Backup e ripristino

| # | Voce | Comando | Esito |
|---|---|---|---|
| 4.1 [S] | Archiviazione continua del WAL attiva | `npm run backup -- check` | ✅ |
| 4.2 [S] | Ripristino a un istante preciso verificato | `npm run backup -- verify` | ✅ 11 s di restore, dati identici |
| 4.3 [I] | Repository di backup su un disco diverso o un secondo repository | `docker/postgres/pgbackrest.conf` | ☐ |
| 4.4 [I] | Timer di backup attivi | `systemctl list-timers 'hivevault-*'` | ☐ |
| 4.5 [I] | Prova di ripristino sul server di produzione | `npm run backup -- verify` | ☐ |
| 4.6 [I] | Documenti originali (`data/blobs/`) nel backup aziendale dei file | strumento dell'azienda | ☐ |

## 5. Installazione [I]

| # | Voce | Riferimento | Esito |
|---|---|---|---|
| 5.1 | HTTPS con certificato valido; `PUBLIC_URL` in `https://` | [installazione §7](guide/installazione.md#7-https) | ☐ |
| 5.2 | `.env` con segreti casuali e permessi 600 | `scripts/install.sh` | ☐ |
| 5.3 | Chiave principale e passphrase dei backup copiate fuori dal server | [installazione §5](guide/installazione.md#5-copia-le-chiavi-fuori-dal-server) | ☐ |
| 5.4 | PostgreSQL e pgbouncer non esposti fuori da `127.0.0.1` | `docker-compose.yml` (`127.0.0.1:` nelle porte) | ☐ |
| 5.5 | Primo amministratore creato, con i codici di recupero salvati | `npm run cb -- admin create` | ☐ |
| 5.6 | Endpoint dei modelli attivi e con lo stesso modello di embedding | Console → Modelli → Prova | ☐ |
| 5.7 | `MODELS_API_KEY` impostata per gli host dei modelli | `.env` | ☐ |
| 5.8 | `METRICS_TOKEN` lungo e casuale (se si usa Prometheus) | `.env` | ☐ |
| 5.9 | Avviso sull'agente cloud riletto e adattato all'azienda | Console → Impostazioni | ☐ |
| 5.10 | Finestra del ciclo notturno adatta agli orari dell'azienda | Console → Impostazioni | ☐ |

## 6. Dopo l'avvio [I]

| # | Voce | Esito |
|---|---|---|
| 6.1 | Dashboard → Panoramica: nessun pannello critico dopo 1 ora | ☐ |
| 6.2 | Primo ciclo notturno concluso (Ciclo notturno: «Completato») | ☐ |
| 6.3 | Un utente di prova accede, cerca, carica un documento e lo vede «Cercabile» | ☐ |
| 6.4 | L'agente cloud collegato con un account API: `brain_search` restituisce risultati con citazioni | ☐ |
