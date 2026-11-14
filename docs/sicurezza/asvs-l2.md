# Revisione di sicurezza — OWASP ASVS 4.0.3, livello 2

Data: 2026-11-02 · Versione: branch `fase-7-admin` (fase 8) · Revisione interna del codice e dei test.

Questa revisione controlla i requisiti del livello 2 che valgono per HiveVault. Per ogni capitolo la tabella dice lo stato e la prova (file o test). Stati: **OK** (soddisfatto e verificato), **APERTO** (da fare prima o durante l'installazione), **N/A** (non si applica: per esempio non ci sono password).

## Riepilogo

| Capitolo | Stato |
|---|---|
| V1 Architettura | OK |
| V2 Autenticazione | OK (nessuna password: TOTP, passkey, firma, chiavi API) |
| V3 Sessioni | OK |
| V4 Controllo degli accessi | OK |
| V5 Validazione e codifica | OK |
| V6 Crittografia dei dati salvati | OK; backup cifrato con pgBackRest (questa fase) |
| V7 Errori e log | OK (redazione dei segreti aggiunta in questa fase) |
| V8 Protezione dei dati | OK (`no-store` sulle risposte dell'API aggiunto in questa fase) |
| V9 Comunicazioni | APERTO in installazione: TLS obbligatorio fuori da `localhost` (checklist di rilascio) |
| V10 Codice malevolo | OK; 2 catene di dipendenze con avvisi moderati non raggiungibili (sotto) |
| V11 Logica di business | OK |
| V12 File e risorse | OK (limiti dell'import zip aggiunti in questa fase) |
| V13 API | OK |
| V14 Configurazione | OK (`Permissions-Policy` e CORP aggiunti in questa fase) |

## Problemi trovati e corretti in questa revisione

| # | Requisito | Problema | Correzione | Test |
|---|---|---|---|---|
| 1 | Invariante 1, V1.1 | Un amministratore poteva aggiungere dalla console un endpoint di embedding o rerank su un indirizzo pubblico: il testo dei documenti sarebbe uscito dalla rete | L'endpoint deve risolversi solo su indirizzi privati (`isPrivateAddress`) | `ops.e2e.test.ts` (8.8.8.8 rifiutato, 192.168.x accettato) |
| 2 | V12.1.1, V12.1.3 | L'import di un vault da zip non limitava la dimensione decompressa (zip bomb) | Limiti di 50.000 file, 50 MB per file e 2 GB in totale, contati durante la decompressione | `ops.e2e.test.ts` (archivio di 100 KB che si espande oltre il limite: 400) |
| 3 | V8.2.1 | Le risposte dell'API non vietavano la cache del browser e dei proxy | `Cache-Control: no-store` predefinito su `/api`, `/mcp`, `/metrics` | `workspace.e2e.test.ts` |
| 4 | V14.4.4–14.4.7 | Mancavano `Permissions-Policy` e `Cross-Origin-Resource-Policy` | Aggiunti a ogni risposta | `workspace.e2e.test.ts` |
| 5 | V7.1.1, V7.1.2 | Il logger scriveva i campi così come arrivano | `redact()`: i valori dei campi segreti (token, codici, chiavi, cookie) e i token Bearer o le chiavi API dentro il testo diventano `[nascosto]` | `log.test.ts` |
| 6 | V2.10.4, V6.2.1 | Il token di `/metrics` era confrontato con `===` | Confronto a tempo costante sugli hash | `ops.e2e.test.ts` |
| 7 | V10.3.2 | `zod` < 4.6.6 (avviso alto: memoria esaurita con collezioni enormi) nel server MCP | `zod` 4.6.7; verificato che gli schemi dei tool arrivano all'agente cloud con i loro parametri | `mcp.e2e.test.ts` |

## V1 — Architettura

| Requisito | Stato | Prova |
|---|---|---|
| 1.1 Componenti e confini di fiducia documentati | OK | `docs/PIANO_DI_SVILUPPO.md` §2–§3, `AGENTS.md` (17 invarianti) |
| 1.4 Un solo punto di decisione per l'accesso | OK | `Access.can` / `requireAction` (`packages/auth/src/authz.ts`); invariante 10 |
| 1.5 Il server ripete ogni controllo, il client non decide | OK | Ogni rotta chiama `requireAction`; la UI nasconde soltanto |
| 1.9 Comunicazioni in uscita controllate | OK | `EgressGuard` su ogni socket (`packages/shared/src/egress.ts`): solo database, modelli e host ammessi; tentativi bloccati nell'audit (`egress.blocked`) e nelle metriche |
| 1.14 Separazione dei privilegi nel database | OK | Ruolo `cb_reader` con RLS per letture di utenti e dell'agente cloud (`withReader`); i job di sistema scrivono come proprietario (invarianti 6 e 8) |

## V2 — Autenticazione

Non ci sono password: si entra con TOTP (RFC 6238), passkey (WebAuthn), firma con chiave (Ed25519, P-256, X.509) o chiave API per le applicazioni.

| Requisito | Stato | Prova |
|---|---|---|
| 2.1 Password | N/A | Nessuna password |
| 2.2.1 Difesa dai tentativi ripetuti | OK | Blocco progressivo per nome utente, in Postgres: 5 errori in 24 h → 15 min, poi 30 min e il doppio fino a 24 h (`lockout.ts`); limite per IP sulle rotte di accesso (`LOGIN_RATE_LIMIT_PER_MIN`) |
| 2.2.3 Notifica dopo eventi di sicurezza | OK | Ogni accesso, errore, reset e cambio di credenziali è nel log di audit, scritto subito (invariante 11) |
| 2.5.4 Nessun account condiviso o predefinito | OK | Il primo amministratore si crea dalla riga di comando (`cb admin create`); nessun utente predefinito |
| 2.5.6 Recupero sicuro | OK | 10 codici di recupero monouso, salvati come hash; il reset del TOTP lo fa un amministratore e chiude le sessioni |
| 2.7/2.8 Codici monouso (TOTP) | OK | Finestra ±1 passo; un codice vale una volta sola (`lastStep`, `totp.ts`); segreto cifrato con AES-256-GCM |
| 2.9 Autenticazione crittografica | OK | Passkey con verifica dell'origine e del contatore; firma su una sfida casuale monouso |
| 2.10 Credenziali dei servizi | OK | Chiavi API casuali da 256 bit, salvate come SHA-256, confronto a tempo costante; scadenza, indirizzi ammessi, limite di richieste per account; la chiave si vede una volta sola |

## V3 — Sessioni

| Requisito | Stato | Prova |
|---|---|---|
| 3.2.1 Nuovo token a ogni accesso | OK | `sessions.create` con 256 bit casuali a ogni accesso |
| 3.3.1/3.3.2 Fine della sessione | OK | Inattività 12 h, durata massima 7 giorni (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`); uscita e revoca lato server |
| 3.3.4 Elenco e chiusura delle sessioni | OK | «Il mio account» e console (utente → sessioni) |
| 3.4 Cookie | OK | `HttpOnly`, `Secure` con HTTPS, `SameSite=Strict`, `Path=/` |
| 3.5 Token per le API | OK | Bearer per gli account API; i cookie non valgono per gli account API |
| 4.2.2 CSRF | OK | Token CSRF legato alla sessione, richiesto su ogni scrittura autenticata da cookie |

## V4 — Controllo degli accessi

| Requisito | Stato | Prova |
|---|---|---|
| 4.1.1 Il server applica i permessi | OK | `requireAction` su ogni rotta; RLS come seconda difesa |
| 4.1.3 Minimo privilegio | OK | Permessi per vault (lettura, scrittura, curatore, amministra); livello di classificazione per account; agente cloud limitato a «interno» (invariante 16) |
| 4.2.1 Riferimenti diretti a oggetti | OK | Pagine e sorgenti lette sotto RLS: un id di un vault non leggibile restituisce 404. Test: `workspace.e2e.test.ts`, `mcp.e2e.test.ts` |
| 4.3.1 Interfacce di amministrazione protette | OK | `admin.*` solo per il ruolo amministratore; nessun accesso con chiave API alla console. Test: `ops.e2e.test.ts` (403 per i membri) |
| Filtro prima del ranking | OK | Partizioni dei vault ammessi scelte prima della ricerca (invariante 6) |

## V5 — Validazione, sanificazione e codifica

| Requisito | Stato | Prova |
|---|---|---|
| 5.1 Validazione dell'input | OK | Schema JSON su ogni corpo e query string (Fastify/Ajv, `additionalProperties: false`); schemi zod sui tool MCP |
| 5.2/5.3 Codifica dell'output (XSS) | OK | Markdown reso con `html: false`, nessun `{@html}` non sanificato (invariante 14); CSP senza script inline |
| 5.3.4 SQL injection | OK | Solo query parametrizzate (`postgres` con template); i nomi dinamici (partizioni) sono generati dal server |
| 5.2.6 SSRF | OK | I link da importare devono puntare a Internet pubblico (controllo DNS e dopo i redirect); gli endpoint dei modelli devono essere privati (correzione 1) |

## V6 — Crittografia dei dati salvati

| Requisito | Stato | Prova |
|---|---|---|
| 6.2.1 Algoritmi approvati | OK | AES-256-GCM per i file originali (chiave per vault, derivata con HKDF dalla chiave principale) e per i segreti TOTP; SHA-256 per le chiavi API |
| 6.4.1 Gestione delle chiavi | OK | Chiave principale in `DATA_DIR/.master-key`, permessi 0600, fuori dal database; da copiare a parte (guida dell'operatore) |
| Backup | OK | pgBackRest con cifratura AES-256 del repository (questa fase) |

## V7 — Errori e log

| Requisito | Stato | Prova |
|---|---|---|
| 7.1.1/7.1.2 Nessun segreto nei log | OK | `redact()` (correzione 5) |
| 7.2 Eventi di sicurezza registrati | OK | Log di audit: accessi, errori, credenziali, permessi, impostazioni, letture dell'agente cloud, connessioni bloccate |
| 7.3 Protezione del log | OK | Il ruolo `cb_reader` non legge `audit_log`; conservazione 400 giorni (`AUDIT_RETENTION_DAYS`) |
| 7.4.1 Messaggi di errore generici | OK | Errori interni: «Errore interno» con dettaglio solo nel log del server |

## V8 — Protezione dei dati

| Requisito | Stato | Prova |
|---|---|---|
| 8.1 Dati sensibili non nella cache | OK | `no-store` (correzione 3) |
| 8.2.2 Dati nel browser | OK | Nel browser restano solo preferenze (tema, layout, schede); niente contenuti |
| 8.3 Classificazione | OK | Classificazione per vault, documento e pagina; l'agente cloud vede solo «pubblico» e «interno», con avviso all'utente (D1) |
| Documenti locali | OK | Invariante 1: gli originali non lasciano il server; modelli solo locali o nella rete aziendale |

## V9 — Comunicazioni

| Requisito | Stato | Prova |
|---|---|---|
| 9.1.1 TLS per ogni connessione dei client | APERTO in installazione | Il server supporta HTTPS (`TLS_CERT_FILE`, `TLS_KEY_FILE`) e invia HSTS; `scripts/dev-ca.sh` crea una CA aziendale. La checklist di rilascio richiede HTTPS fuori da `localhost` |
| 9.2 Connessioni verso i servizi | Accettato | Postgres e modelli sulla rete interna in HTTP/TCP; per reti non fidate usare TLS di Postgres e un proxy TLS davanti a llama-server |

## V10 — Codice malevolo e dipendenze

| Requisito | Stato | Prova |
|---|---|---|
| 10.3.2 Dipendenze senza vulnerabilità note | OK con eccezioni | `npm audit --omit=dev`: `zod` corretto. Restano 9 avvisi moderati in due catene non raggiungibili: `glob`/`minimatch` in `@fastify/static` (usato solo con `wildcard: true`, noi usiamo `false`); `archiver` in `exceljs` (serve a scrivere xlsx, noi li leggiamo soltanto). Da ricontrollare a ogni rilascio |

## V11 — Logica di business

| Requisito | Stato | Prova |
|---|---|---|
| 11.1.2 Limiti di frequenza | OK | Limite per account e per IP; limite per account API configurabile |
| 11.1.4 Limiti di risorse | OK | Dimensione dei caricamenti (`UPLOAD_MAX_MB`), corpo JSON 2 MB, budget di token e tempo per il ciclo notturno, limite di serie delle metriche (5000) |
| L'agente cloud non scrive direttamente | OK | `brain_capture` solo nella inbox, `brain_propose_edit` in coda ai curatori |

## V12 — File e risorse

| Requisito | Stato | Prova |
|---|---|---|
| 12.1 Dimensione e numero dei file | OK | Limiti di caricamento, zip con limiti di espansione (parser e import dei vault) |
| 12.3 Percorsi | OK | Nessun nome di file del client usato come percorso; import zip con controllo del path traversal; import massivi solo sotto `IMPORT_ROOTS` |
| 12.4 Contenuti caricati | OK | Formato riconosciuto dal contenuto, non dall'estensione; parser in worker thread; originali scaricabili come allegato |

## V13 — API

| Requisito | Stato | Prova |
|---|---|---|
| 13.1.3 Nessun segreto nell'URL | OK | Chiavi solo nell'header `Authorization`; codice di attivazione nel frammento `#` del link |
| 13.2 REST | OK | Metodi corretti, schema su ogni corpo, CSRF sulle scritture con cookie |

## V14 — Configurazione

| Requisito | Stato | Prova |
|---|---|---|
| 14.4 Header di sicurezza | OK | CSP senza inline, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, CORP, `Permissions-Policy`, HSTS con HTTPS |
| 14.3 Nessuna informazione di debug | OK | Nessun stack trace al client; mappe dei sorgenti solo nei file statici |
| 14.1 Build ripetibile | OK | `package-lock.json`; script di installazione (questa fase) |

## Cose da fare in installazione (dalla checklist di rilascio)

1. HTTPS con un certificato della CA aziendale; `PUBLIC_URL` in `https://`.
2. `POSTGRES_PASSWORD` diversa da quella di sviluppo; Postgres e pgbouncer solo su `127.0.0.1` o sulla rete interna.
3. Copia della chiave principale (`DATA_DIR/.master-key`) e della chiave del repository pgBackRest fuori dal server.
4. `METRICS_TOKEN` lungo e casuale se si usa Prometheus.
5. Chiavi API degli host dei modelli (`MODELS_API_KEY`) impostate.
