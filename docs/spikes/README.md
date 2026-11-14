# Fase 0 — esiti degli spike

Data: 2026-10-27 · Macchina: AMD Ryzen 9 9900X (24 thread), 62 GB RAM, Windows 11, Docker Desktop (VM 32 GB) · PostgreSQL 17.11 + pgvector 0.8.7

Rapporti completi: [spike-a.md](spike-a.md) · [spike-c.md](spike-c.md) · [spike-d.md](spike-d.md)

## Spike A — task engine durevole

**Esito: confermato.** 300 task da 4 fasi, 3 processi worker, 19 processi uccisi con SIGKILL durante l'esecuzione:
tutti i task completati, ogni effetto sul database eseguito **esattamente una volta**, nessun effetto perso.
Una fase interrotta riparte dall'ultimo checkpoint; il recupero dopo un crash richiede al massimo la durata del lease (1,5 s nel test) più il ciclo del reaper.

Decisione: il task engine su Postgres (`FOR UPDATE SKIP LOCKED`, lease con fencing, effetti nel journal) è la base di ingestion e dream cycle. Nessuna coda esterna.

## Spike C — PostgreSQL + pgvector in scala

Chunk sintetici di ~700 caratteri, `halfvec(1024)`, 20 partizioni per vault. Latenze p95 dal client Node.

| Chunk | Spazio totale | Ibrida, 3 vault | Ibrida, tutti | Vettori, tutti (ef 40) | Recall@10 (ef 40 / 100) |
|---|---|---|---|---|---|
| 1M | 6,8 GB | 10,7 ms | 69 ms | 35 ms | 99,3% / 100% |
| 2M | 14,7 GB | 24,2 ms | 94 ms | 38 ms | 99,3% / 99,7% |
| 5M | 34,7 GB | 145 ms | 1.560 ms | 886 ms | 93,3% / 97,7% |

Cosa abbiamo imparato:

1. **Il fattore decisivo è la RAM, non il numero di righe.** Fino a 2M chunk dati e indici stanno nella cache (VM da 32 GB) e tutte le query restano sotto i 100 ms. A 5M (34,7 GB) non ci stanno più e le latenze crescono di 10–20 volte. Regola di dimensionamento: **indice HNSW + parte calda della tabella devono stare in RAM**.
2. **Il partizionamento per vault funziona come previsto.** Con 3 vault consentiti la query tocca solo le loro partizioni (Merge Append di tre scansioni HNSW): è 4–10 volte più veloce della ricerca su tutti i vault ed è anche il meccanismo dell'ACL.
3. **La quantizzazione binaria è la strada per la scala TB.** A 1M chunk: indice di 0,40 GB invece di 2,54 GB (6 volte più piccolo), recall@10 96,7% con rescoring sui primi 200 candidati, latenza simile con 3 vault. Per 50M chunk: ~20 GB di indice invece di ~127 GB.
4. **Gli inserimenti incrementali degradano un po' l'HNSW** (recall al 93% a 5M con ef 40). Rimedi: `ef_search` 100 sulle partizioni grandi e `REINDEX CONCURRENTLY` delle partizioni nel dream cycle.
5. **Il full-text con `ts_rank_cd` è il punto debole** quando i dati non sono in cache (p95 1 s su tutti i vault a 5M): il ranking legge il `tsvector` di ogni riga che corrisponde. Va confrontato con ParadeDB `pg_search` (BM25 su indice) prima della fine della fase 1.
6. **Il caricamento non è un collo di bottiglia.** COPY binario: 23k righe/s senza indici, 900–2.100 righe/s con HNSW aggiornato. Gli embedding in CPU producono ~30 chunk/s, quindi il database non rallenta l'ingestion. Per l'import massivo conviene caricare prima e costruire l'indice dopo, per partizione.
7. Il confronto `halfvec(512)` (recall 38,7%) **non è valido**: i vettori sintetici non sono Matryoshka. Va ripetuto con il modello reale.
8. Docker: `shm_size` deve superare `maintenance_work_mem`, altrimenti la build parallela dell'HNSW fallisce (corretto in `docker-compose.yml`).

## Spike D — embedding in CPU, locale e remoto

Modello sostitutivo: `nomic-embed-text-v1.5` Q4 (137M parametri, già presente sulla macchina). Quello previsto, Qwen3-Embedding-0.6B, è circa 4 volte più grande: ci aspettiamo 1–1,5k token/s con 12 thread, da misurare dopo il download.

| Thread | Token/s | Chunk/s | Memoria del processo |
|---|---|---|---|
| 4 | 2.451 | 16,8 | 577 MB |
| 8 | 3.801 | 26,1 | 579 MB |
| 12 | 4.661 | 32,0 | 581 MB |

1. **Supervisore e dispatcher funzionano con un llama-server reale**: avvio, health check, due endpoint insieme con lavoro distribuito per velocità (204 / 206), endpoint con modello diverso rifiutato (`mismatch`).
2. **Problema trovato e corretto: latenza delle query durante il backfill.** llama-server mette i testi di una richiesta in una coda FIFO interna: con lotti da 16 testi, una query interattiva aspettava fino a 6,2 s. Correzioni nel dispatcher:
   - 1 slot per endpoint riservato alle query interattive;
   - lotti in background divisi in richieste da 2 testi (stesso throughput, perché llama-server accorpa comunque gli slot).

   Risultato: query durante il backfill con p95 **646 ms** (prima 6.154 ms), throughput invariato (~5.000 token/s).
3. **Qualità (indicativa):** hit@5 65% con nomic contro 46% del mock lessicale. Sulle domande con un valore aggiornato nel tempo solo 30%: la ricerca vettoriale da sola non sa quale valore è quello attuale. Conferma la scelta delle pagine compilate (stato attuale + timeline).

## Decisioni e azioni per la fase 1

| # | Decisione / azione |
|---|---|
| 1 | Indice vettoriale di default sugli spazi grandi: **HNSW su `binary_quantize` + rescoring in `halfvec`**; HNSW `halfvec` completo solo sugli spazi piccoli e molto consultati. |
| 2 | Dimensionamento RAM della produzione: indice HNSW + parte calda della tabella × 1,2. |
| 3 | Spike C2 (prima della fine della fase 1): ParadeDB `pg_search` contro `tsvector`, e `pgvectorscale` (StreamingDiskANN). Servono immagini Docker diverse. |
| 4 | Scaricare Qwen3-Embedding-0.6B e Qwen3-Reranker-0.6B (GGUF Q8_0, ~0,65 GB ciascuno) e ripetere lo spike D: throughput reale, qualità in italiano, troncamento a 512. **Serve la tua autorizzazione al download.** |
| 5 | Dream cycle: `REINDEX CONCURRENTLY` delle partizioni con HNSW degradato; `ef_search` per partizione in base alla dimensione. |
| 6 | Chunk reali più lunghi (300–800 token, ~2.000 caratteri): rifare le stime di spazio con il corpus reale della fase 3. |

---

# Fase 1 — motore della memoria

Data: 2026-10-27 · stessa macchina della fase 0

Rapporti: [phase1-bench-long.md](phase1-bench-long.md) · [phase1-bench-tiny.md](phase1-bench-tiny.md) · [spike-c2-paradedb.md](spike-c2-paradedb.md) · [spike-c2-timescale.md](spike-c2-timescale.md)

## Benchmark di accettazione (motore completo, 1M chunk, 20 vault)

Misure end-to-end del `SearchEngine` vero: embedding della query, transazione con ruolo `cb_reader` e RLS, SQL, raggruppamento, snippet, budget. Cache disattivata.

| Operazione | p95, vocabolario realistico | p95, vocabolario minimo (caso peggiore) | Obiettivo (§0.2) |
|---|---|---|---|
| Ricerca ibrida, 3 vault | **30,5 ms** | 31,8 ms | < 200 ms ✅ |
| Ricerca ibrida, 20 vault (tutto l'alveare) | **86,5 ms** | 85,4 ms | < 600 ms ✅ |
| Ricerca per titolo, solo pagine | 49,4 ms | 48,7 ms | — |
| Lettura pagina con budget (800 token) | 4,5 ms | 4,3 ms | < 20 ms ✅ |
| Ricerca ripetuta (cache) | 1,3 ms | 0,9 ms | — |

Caricamento in blocco: ~19.500 chunk/s, poi indice binario sulle 20 partizioni in ~75 s. Spazio: 5,2 GB per 1M chunk (tabelle + indici).

## Tre problemi trovati dal benchmark e corretti

| # | Sintomo (20 vault) | Causa | Correzione |
|---|---|---|---|
| 1 | 2,7 s | Le policy RLS chiamavano `cb_vaults()` per ogni riga candidata | Migrazione 003: `(select cb_vaults())`, calcolato una volta (InitPlan) |
| 2 | 0,9 s | Con la RLS, l'operatore full-text `@@` non è LEAKPROOF: Postgres non usava l'indice GIN e leggeva tutte le partizioni | Migrazione 004: `ts_match_vq` e `similarity_op` marcati LEAKPROOF (motivazione nel file). Serve un superuser |
| 3 | — | La `tsquery` presa da una sottoquery in join non è una condizione d'indice | `tsquery` scritta direttamente nel `WHERE` |

Tentativo scartato: statement preparati. Il piano generico di Postgres per questa query partizionata era 2–3 volte più lento.

## Spike C2 — alternative per full-text e vettori

**Full-text, 1M chunk, una tabella** (p95 ms, 20 vault):

| Metodo | Query con termine raro | Query con parole comuni |
|---|---|---|
| tsvector, AND (`websearch_to_tsquery`, usato dal motore) | 5,5 | 18,0 |
| tsvector, OR | 657 | 990 |
| ParadeDB `pg_search` 0.26 (BM25, OR) | 22,5 | 22,8 |

- La semantica AND di Postgres è veloce con un vocabolario reale, ma esige tutte le parole: su domande in linguaggio naturale perde risultati, che oggi recupera il ramo vettoriale.
- ParadeDB dà BM25 vero con semantica OR a latenza costante, ma: **licenza AGPL-3.0**, immagine su **PostgreSQL 18**, indice 2,3× più grande del GIN.

**Vettori, 1M × 1024, una tabella** (p95 ms / recall@10, 20 vault):

| Indice | Build | Dimensione | Latenza | Recall@10 |
|---|---|---|---|---|
| pgvector HNSW binario + rescoring | 35 s | 0,40 GB | 7,6 ms | 76,3% |
| pgvectorscale DiskANN (SBQ) | **1.401 s** | 0,54 GB | 10,3 ms | 89,8% |
| DiskANN con etichette per vault | build interrotta (~1 h 45 min stimata) | — | — | — |

- DiskANN si costruisce 40 volte più lentamente. Su una sola tabella ha recall migliore, ma il nostro schema partizionato per vault dà già **96,7%** con l'HNSW binario (spike C, partizioni da 50k).
- L'immagine TimescaleDB ha la telemetria attiva per default.

## Decisioni

| # | Decisione |
|---|---|
| 1 | **Restiamo su pgvector** (HNSW binario per partizione). DiskANN scartato: costo di build incompatibile con import massivo e REINDEX notturno, nessun vantaggio di recall con le partizioni. |
| 2 | **Full-text: tsvector in AND** per ora (obiettivi raggiunti). ParadeDB resta un'opzione per la qualità del ranking: decisione D11, da valutare con l'eval reale della fase 6. |
| 3 | La soglia di similarità vettoriale (`minVectorSimilarity`) va calibrata col modello reale: oggi è 0 (disattivata). |
| 4 | Le migrazioni che toccano funzioni di sistema (004) vanno eseguite da un superuser: da scrivere nella guida di installazione. |

---

# Fase 2 — autenticazione, autorizzazione, API di amministrazione

Data: 2026-10-27

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Account | Una tabella `principals` per persone e account API; ruoli `admin`, `curator`, `member`; ambiti API `read`, `write`, `ingest`, `admin`; clearance 0–3 |
| TOTP | RFC 6238 implementata nel progetto (verificata con i vettori ufficiali RFC 6238 e RFC 4226). Segreto cifrato con la chiave master (AES-256-GCM, legato all'account). Un codice vale una volta. 10 codici di recupero |
| Attivazione | L'admin crea l'utente e riceve un codice monouso (24 h). L'utente lo usa nella pagina di attivazione o con `npm run cb -- enroll <codice>` (QR nel terminale) |
| Passkey | WebAuthn (SimpleWebAuthn 13), attestazione "none", login anche senza nome utente. Rifiuta origini diverse e risposte ripetute |
| Firma | `cb-auth-v1\|utente\|nonce\|ts` firmato con Ed25519, ECDSA P-256 o certificato X.509 della CA aziendale. Nonce monouso (60 s), ts ±60 s. CLI `npm run cb -- login --key` |
| Chiavi API | `cb_<id>_<segreto>`, solo l'hash nel database; scadenza, revoca, IP consentiti (CIDR v4/v6), limite di richieste per account |
| Sessioni | Token casuale nel cookie `HttpOnly; SameSite=Strict` (e `Secure` in HTTPS), hash nel database; scadenza per inattività (12 h) e assoluta (7 giorni); token CSRF per sessione (double submit) |
| Protezioni | Blocco progressivo per nome utente (5 errori → 15 min, poi raddoppia fino a 24 h), stesso messaggio per utente inesistente, rate limit per IP sui login e per account sul resto, intestazioni di sicurezza (CSP, HSTS in HTTPS, X-Frame-Options) |
| Autorizzazione | Una sola funzione (`Access`): admin = tutto; membri = permessi per vault + la propria cella; account API = permessi limitati dai loro ambiti. La lista dei vault leggibili è la stessa che riceve la RLS |
| Admin API | CRUD di utenti, account API, chiavi, passkey, chiavi pubbliche, vault, permessi, sessioni; ricerca nell'audit. Non si può eliminare/sospendere/retrocedere sé stessi né l'ultimo admin |
| Audit | Ogni login (riuscito o no), ogni modifica di amministrazione e credenziali (scrittura immediata); ogni ricerca e lettura degli account API (scrittura raggruppata, con la classificazione dei risultati) |
| HTTPS | `scripts/dev-ca.sh`: CA locale + certificato server con SAN |

## Verifica

- 115 test in totale (23 nuovi in `auth`, 11 end-to-end HTTP in `server`), tutti superati, anche ripetendo l'esecuzione sullo stesso database di test.
- End-to-end via HTTP: i tre metodi di accesso e i codici di recupero; attivazione; CSRF; salvaguardie dell'admin; un membro vede solo i vault concessi (ricerca, lettura, grafo) e perde l'accesso appena il permesso è revocato; un account API vede solo i suoi vault e fino alla sua clearance, non usa l'API di amministrazione, le sue letture sono nell'audit, la chiave revocata smette subito di funzionare.
- Server reale (`npm start`) e CLI (`key gen`, `login --key`) provati sul database di test.
- TLS: il server presenta il certificato della CA locale con HSTS; senza la CA il client lo rifiuta.

## Da sapere

1. **Antivirus che intercetta il TLS.** Su questa macchina Avast (Web/Mail Shield) intercetta le connessioni HTTPS, anche verso `localhost` e dai container Docker, e sostituisce i certificati che Windows non considera fidati con uno "Avast Untrusted Root". Conseguenze: browser e CLI rifiutano il server finché la CA locale (`data/tls/ca.pem`) non è importata tra le autorità radice fidate di Windows; la CLI Node ha bisogno anche della radice di Avast, oppure di un'eccezione per l'indirizzo del server nell'antivirus. Sui computer aziendali con antivirus simili vale lo stesso: va scritto nella guida di installazione.
2. **La chiave master protegge anche i segreti TOTP.** Senza `BRAIN_MASTER_KEY` (o `data/.master-key` in sviluppo) nessuno può più accedere con TOTP: va salvata fuori dal server, come per i documenti cifrati.
3. **Il rate limit è in memoria**, per un processo. Con più istanze del server servirà un contatore condiviso (Postgres o Redis). Il blocco dei login è già in Postgres.
4. **L'audit non è ancora partizionato per mese** (indice BRIN sul tempo). Il partizionamento e la ritenzione arrivano con il ciclo notturno.
5. `PUBLIC_URL` fissa l'RP ID delle passkey: cambiarlo in seguito invalida le passkey registrate.

# Fase 3 — ingestion e import massivo

Data: 2026-10-27

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Parser locali | `@cb/parsers`: PDF (unpdf, pagine, segnala `needs_ocr`), DOCX (mammoth + tabelle), XLSX e CSV (tabelle Markdown, riassunto oltre 200 righe), PPTX (diapositive e note), EML, MSG, MBOX (citazioni rimosse), HTML (Readability), ZIP (limiti contro le zip bomb), codice (simboli come titoli), testo (UTF-8 / Windows-1252). Formato riconosciuto dal contenuto, non dall'estensione |
| Worker pool | Thread separati (piscina) con timeout per file: un parser bloccato non ferma il server |
| Sorgenti | L0 cifrato per vault, dedup per hash nel vault, figli (allegati, file dello ZIP) fino a profondità 4 |
| Pipeline `ingest` | Task durevole con fasi `parse → index → embed → compile`: I1 = chunk e full-text, I2 = embedding, I3 = pagine compilate. Errori permanenti → stato `unsupported` / `failed`, senza nuovi tentativi |
| Compilatore | Pagina sorgente estrattiva (sempre, senza modello) + agente del modello con i tool `source_read`, `wiki_search`, `wiki_read`, `wiki_write`. `validate` rifiuta pagine senza citazioni, punti di "Stato attuale" senza citazione e citazioni a sorgenti sconosciute |
| Compilazione su richiesta | Le sorgenti I1/I2 trovate spesso dalle ricerche passano a I3 (contatore `demand`) |
| Link | Solo http/https, niente credenziali nell'URL, DNS controllato contro indirizzi privati, redirect manuali (max 5), 20 MB, 30 s |
| Import massivo | Task `import` con fasi di scansione e memorizzazione, tabella `import_files` per la scansione incrementale, glob di inclusione/esclusione, file di sistema saltati, limite di velocità, finestra oraria, pausa/ripresa/annullamento/nuova scansione. Solo cartelle sotto `IMPORT_ROOTS` (percorso reale, niente uscita con link simbolici) |
| API | Upload multipart, link, elenco e dettaglio sorgenti, originale (solo persone, mai account API), reingest, compila ora, eventi SSE; `/api/admin/imports` |
| Guardia di rete | `EgressGuard`: ogni connessione in uscita passa da un controllo (database, server dei modelli, `EGRESS_ALLOW`); i link scaricati hanno un permesso valido solo per quella richiesta. Le connessioni rifiutate vanno nell'audit |

## Verifica

| Criterio di accettazione | Esito |
|---|---|
| Corpus di prova, 20 file per 13 formati | 260 file analizzati senza errori, con i marcatori e i figli attesi ([test](../../packages/parsers/test/parsers.test.ts)) |
| Kill durante la compilazione → ripresa senza duplicati | SUPERATO: 72 sorgenti, 7 SIGKILL, 33 task ripresi, 0 pagine mancanti o duplicate, la pagina condivisa ha 1 copia e 85 versioni ([rapporto](phase3-crash.md)) |
| Import di 1 milione di file con avanzamento corretto | SUPERATO: 1.000.000 salvati, 0 duplicati, 0 errori, tutti indicizzati (I1), avanzamento crescente e somme corrette, 134,8 min, 4,4 GB nel database ([rapporto](phase3-import-1000000.md)) |
| Nessuna connessione in uscita non consentita | Test della guardia (host non consentito rifiutato, `allowFor` limitato alla richiesta), link verso indirizzi interni rifiutati, server reale avviato con la guardia attiva |

Test: 154 in totale, tutti superati (due esecuzioni sullo stesso database).

## Prestazioni dell'import

| Prova | File/s |
|---|---|
| 20.000 file, memorizzazione in serie | 60 |
| Memorizzazione in parallelo (16 per task), versione del vault aggiornata fuori dalla transazione | 145 |
| 4 processi worker invece di 2 | 128 (nessun vantaggio: il collo di bottiglia è il commit) |
| `synchronous_commit = off` nel pool dei worker | 535 |
| 1.000.000 di file (media) | 125 |

Durante l'import da 1 milione la velocità scende da circa 460 file/s (primi minuti) a circa 90 file/s (ultimi minuti). La causa non è ancora misurata. Ipotesi: tabelle `tasks` e `task_events` che crescono (1 task per file), indice GIN del full-text di un'unica partizione che riceve tutti i chunk, memorizzazione e indicizzazione che condividono gli stessi posti di lavoro. Da profilare in fase 8 (`pg_stat_statements`, `EXPLAIN ANALYZE`); possibili rimedi: task di indicizzazione a lotti invece di un task per file, pulizia dei task conclusi.

## Decisioni

1. **Commit asincroni solo per i worker.** Le fasi dei task sono idempotenti: se il database si ferma, gli ultimi commit persi vengono rifatti. Login, sessioni, admin e audit restano sul pool con commit sincrono.
2. **La pagina sorgente è estrattiva.** Ogni sorgente ha subito una pagina citabile senza modello; il modello aggiunge solo pagine di entità, con citazioni obbligatorie.
3. **L'originale non esce mai verso gli account API.** L'agente cloud riceve solo testo compilato (invariante 1).

## Non ancora fatto

- OCR: le immagini e i PDF scansionati sono segnalati (`ocr_unavailable`, `needs_ocr`), non letti.
- Sidecar docling (PDF complessi) e readpst (PST); formati legacy `.doc` / `.xls`.
- Nessun generatore di file MSG: il parser MSG non ha ancora un test automatico.
- Compilazione con il modello reale non provata: l'host dei modelli è spento. Prova prevista in fase 6 con l'eval di recupero.

# Fase 4 — interfaccia utente stile Obsidian

Data: 2026-10-28

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Accesso | TOTP, passkey (anche senza nome utente), codice di recupero, attivazione con QR e codici di recupero. Gestione di passkey e sessioni nella pagina «Il mio account» |
| Shell | Barra delle azioni, barra laterale (vault, inbox, «Da rivedere», preferiti, recenti, cartelle per tipo), schede con cronologia propria, due pannelli affiancati, pannello dei dettagli. Lo stato dell'area di lavoro resta nel browser; l'indirizzo mostra la vista attiva (`#/p/<id>`, `#/cerca?q=…`) |
| Tastiera | `Ctrl K` comandi, `Ctrl O` apri una pagina, `Ctrl Maiusc F` cerca, `Ctrl \` dividi, `Alt ←/→` cronologia, `Ctrl E` modifica, `Ctrl S` salva, `Alt N` nuova pagina, `Alt T`/`Alt W` schede, `Ctrl B` barre laterali. Le scorciatoie che il browser riserva (`Ctrl T`, `Ctrl W`, `Ctrl N`) restano al browser |
| Lettura | `[[link]]` risolti con la tabella dei link (anche verso vault diversi, se leggibili), link mancanti tratteggiati con creazione al clic, citazioni numerate con la fonte al passaggio del mouse e apertura della sorgente al punto citato, callout, liste di compiti, ancore di sezione e di blocco, elenco «Fonti» |
| Pannello dei dettagli | Struttura, backlink e menzioni non collegate (full-text del titolo e degli alias), grafo locale (profondità 1–2), proprietà |
| Anteprime | Al passaggio del mouse su un link: lettura con budget (260 token) della pagina collegata; la pagina è anche prelevata in anticipo |
| Editor | CodeMirror 6 sul file Markdown completo, completamento di `[[` da titoli e alias del vault, anteprima affiancata, `Ctrl S`; un salvataggio concorrente risponde 409 e l'utente sceglie se ricaricare o sovrascrivere. Storico delle versioni con differenze riga per riga |
| Ricerca | Filtri per vault e tipo applicati dal server prima del ranking; faccette per genere (pagina/documento) e livello (I1/I2/I3); anteprima dei passaggi trovati; navigazione da tastiera |
| Grafo | Canvas con simulazione di forze, zoom, spostamento, trascinamento, tastiera; filtri per vault e tipo; caricamento progressivo (prima le pagine più collegate) |
| Sorgente | Originale mostrato dal browser (PDF, immagini, testo: `?inline=true`, framing solo dalla stessa origine, sandbox per immagini e testo) accanto al testo estratto, con la parte citata evidenziata; rielabora, compila ora |
| Caricamento | Trascinamento ovunque nella finestra, file o link, scelta di vault e classificazione con l'avviso sull'agente cloud prima dell'invio, avanzamento del trasferimento, stato di ogni documento dagli eventi del server |
| Avvisi D1 | Informativa al primo accesso (non si chiude senza conferma, conferma nell'audit), segno «☁ Consultabile dall'agente cloud» quando almeno un account API attivo può leggere la pagina, pannello «Cosa ha letto l'agente cloud» con le letture delle pagine della propria cella |
| Server | Rotte `routes/workspace.ts` e letture `brain/src/browse.ts` (sempre con `withReader`), migrazione 008, compressione brotli/gzip, file dell'app con cache di un anno (nomi con hash), `robots.txt` che esclude l'indicizzazione |

## Verifica

| Criterio di accettazione | Esito |
|---|---|
| Test Playwright dei flussi principali nei 4 temi | 33 test (8 flussi × 4 temi + accesso), tutti superati in due esecuzioni consecutive: accesso con TOTP e informativa, codice sbagliato, quick switcher, wikilink, anteprima, cronologia, ricerca a faccette, modifica con completamento e salvataggio, caricamento con eventi in tempo reale, pannelli divisi, grafo, palette, controllo axe WCAG 2.1 AA di 5 viste |
| Lighthouse ≥ 90 | Prestazioni 92–99, accessibilità 100, best practice 100 su accesso, inizio, pagina, ricerca, grafo e inbox (desktop, tema carta). SEO 63 per scelta: `robots.txt` esclude un'applicazione interna dai motori di ricerca |
| Apertura pagina < 100 ms percepiti | 1,6–1,9 ms dal clic alla pagina disegnata per una pagina già vista o sorvolata (cache e prelievo anticipato); una pagina nuova costa una richiesta (`/api/pages/:id/full`, decine di ms in LAN) con lo scheletro della pagina mostrato subito |

Test: 166 unitari e di database (8 nuovi sul renderer Markdown, 4 sulle API dell'interfaccia), tutti superati. Bundle iniziale 248 KB (91 KB compressi); editor (566 KB) e grafo (21 KB) si caricano alla prima apertura o quando il browser è inattivo.

Schermate: [docs/ui/](../ui/) (`SCREENSHOTS=1 npm run e2e` le rigenera).

## Problemi trovati dai test e corretti

1. **Link tra vault.** Il motore risolve un `[[link]]` dentro il vault della pagina; un link da «Tecnico» a un cliente di «Clienti» restava non risolto. Le letture ora risolvono questi link sui titoli e alias dei vault leggibili: pagina, backlink, conteggio, grafo globale e locale.
2. **Quick switcher troppo veloce.** Con `Invio` premuto prima della risposta del server si apriva la riga della ricerca precedente. Ora `Invio` aspetta i risultati della query scritta.
3. **Contrasto.** `--text-dim` e i colori dei link dei temi originali sono sotto 4,5:1 per il testo piccolo (fino a 3,19:1 nel tema notte). I blocchi copiati restano uguali; `base.css` sposta questi colori verso `--text-main` quanto basta per l'AA in tutti i temi. Ridisegnati i segni di livello I1/I2/I3 e l'evidenziazione dei termini cercati.
4. **Estratti della ricerca.** Il server restituisce `snippet` con i termini tra «»; l'interfaccia li rende sicuri (testo escapato, poi `<mark>`).

## Da sapere

1. **Schermate al posto dei mockup.** Il piano (§9.3) chiedeva mockup da approvare prima di sviluppare le viste. Le viste sono state costruite direttamente sul design system della fase 0; le schermate reali in `docs/ui/` servono per la revisione.
2. **Editor con anteprima affiancata**, non «live preview» in linea come Obsidian: CodeMirror mostra il Markdown, l'anteprima accanto si aggiorna mentre si scrive.
3. **Embedding delle pagine scritte a mano.** Il testo modificato è subito cercabile per parole chiave; i vettori delle pagine modificate dall'editor arrivano con il ciclo notturno (fase 5), perché oggi l'indicizzatore gira solo nella pipeline delle sorgenti.
4. **Accesso con firma** solo dalla riga di comando (`npm run cb -- login --key`): il browser non ha accesso alle chiavi private.
5. **Test con il browser installato.** Playwright usa Edge (`E2E_CHANNEL=chrome` per Chrome): nessun browser scaricato. I test usano il database di sviluppo e cancellano i loro dati alla fine.
6. **In sviluppo** le sorgenti restano a I1: il modello di embedding finto non ha l'identità del modello configurato e il dispatcher rifiuta di mescolare vettori (invariante 3). È il comportamento voluto.

# Fase 5 — alveare e ciclo notturno

Data: 2026-10-28

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Claims | `@cb/hive/claims.ts`: ogni punto dello «Stato attuale» diventa un'affermazione (`Etichetta: valore`, oppure una quantità come «250 postazioni»; il resto è una nota che non va mai in conflitto). Etichette con lo stesso significato hanno un solo predicato (`numero di postazioni` = `postazioni`); i valori sono normalizzati (`1.250` = `1250`, i wikilink diventano testo). La sincronizzazione legge solo le pagine cambiate (`pages.claims_at`) e ritira i punti tolti |
| Celle e spazi | `hive_feeds`: quali celle alimentano uno spazio e per quali tipi di pagina (predefinito: entità). Configurazione con `PUT /api/admin/vaults/:id/feeds` |
| Promozione | Le pagine delle celle sullo stesso soggetto sono unite per titolo e alias. Un valore → una riga con le fonti (`· 2 fonti concordi`); più valori → blocco `> [!conflict]` e voce nella coda. Ogni frase cita la pagina d'origine `^[pagina#blocco]`; sezione «Provenienza» con celle e pagine. Le pagine `privato` non escono dalla cella; la pagina d'alveare prende la classificazione più alta delle sue fonti. La pagina è ricostruita ogni volta dai claims attivi: un'informazione ritirata nella cella sparisce dall'alveare, un soggetto senza claims porta via la pagina |
| Coda dei curatori | `curator_items`: conflitti, possibili duplicati, valori con fiducia bassa (sotto 0,6), contraddizioni dentro una cella. Una decisione (un valore, un valore scritto dal curatore, «sono tutti validi») aggiorna subito la pagina e vale alle promozioni successive, finché i valori nelle celle non cambiano: allora si apre una voce nuova. I duplicati si uniscono dalla coda (alias + redirect, nessun link rotto). Permesso `curate` sullo spazio; ogni decisione va nell'audit |
| Ciclo notturno | Task durevole per vault e notte con i 12 passi del piano (vedi sotto). Ogni chiamata della fase fa un lotto limitato e salva passo, cursore e rapporto: un worker ucciso riprende dal lotto successivo. Lavora solo nella finestra (`DREAM_WINDOW`, predefinita 22:00–06:00) e nel budget per vault e notte (`DREAM_BUDGET_MINUTES`, `DREAM_BUDGET_TOKENS`); poi dorme fino alla notte dopo e riprende dallo stesso punto |
| Scheduler | Un task che si sveglia all'inizio di ogni finestra: un ciclo per vault (prima le celle, poi gli spazi), nessun secondo ciclo per un vault ancora in pausa, pulizia globale (task conclusi oltre 30 giorni, audit oltre 400 giorni) |
| Modelli locali | Qwen3-Embedding-0.6B e Qwen3-Reranker-0.6B (Q8_0) in `data/models/`, avviati e sorvegliati dal server con il llama-server già usato nello spike D (CPU, 8 thread) |
| Interfaccia | «Coda dei curatori» (scegli un valore, scrivine uno, tieni tutti; unisci i duplicati), «Ciclo notturno» (rapporto per vault e notte, dettagli per passo), segno «Alveare · N celle» sulle pagine, fonti di celle non accessibili mostrate come tali (non come errori), pagine generate in sola lettura |

### I 12 passi

| # | Passo | Cosa fa | Modello |
|---|---|---|---|
| 1 | reparse | Sorgenti lette da una versione vecchia del parser → nuova elaborazione | — |
| 2 | backlog | Vettori mancanti (sorgenti e pagine scritte a mano), compilazione I3 delle sorgenti richieste (`DREAM_COMPILE_PER_NIGHT`) | embedding locale |
| 3 | dedup | Titoli simili (trigrammi) dello stesso tipo: stessa entità a meno della forma giuridica → unione; altrimenti giudica il modello; se non è sicuro (< 0,9) → coda | chat, JSON |
| 4 | crosslink | Prima menzione non collegata di un titolo o alias → `[[link]]` (mai in codice, titoli, link, citazioni; nomi ambigui saltati) | — |
| 5 | lint | Claims sincronizzati; orfane, link rotti, pagine più vecchie delle loro sorgenti, contraddizioni → pagina `_inbox/manutenzione.md` e coda | — |
| 6 | tldr | Sintesi delle pagine cambiate senza `tldr`; scartata se contiene numeri che non sono nella pagina | chat, JSON |
| 7 | promote | Promozione cella → alveare (solo negli spazi con celle collegate) | — |
| 8 | importance | `ln(1+backlink) + 0,7·ln(1+letture in 30 giorni) + recenza` | — |
| 9 | indexes | Indice per categoria e `llms.txt` (le pagine più importanti per prime) in `vault_indexes`; `GET /api/vaults/:id/index/llms` | — |
| 10 | database | `VACUUM (ANALYZE)` della partizione dei chunk se più del 10% delle righe è morto; `ANALYZE` se più vecchio di 7 giorni | — |
| 11 | backup | Lettura e verifica dell'hash di 5 originali a caso dal raw store cifrato; pgBackRest arriva in fase 8 | — |
| 12 | report | Riga in `vault_log` (tipo `dream`) e `dream_runs` concluso | — |

## Verifica

| Criterio di accettazione | Esito |
|---|---|
| Due celle con informazioni concordi e discordi → pagina d'alveare con provenienza e conflitto aperto | SUPERATO ([test](../../packages/hive/test/hive.test.ts)): «Postazioni: 250 ^[A] ^[B] · 2 fonti concordi», blocco di conflitto sul referente tecnico con i valori di ciascuna cella, voce aperta in coda; decisione del curatore applicata subito e mantenuta; valore nuovo in una cella → la decisione vecchia non vale più e si apre un conflitto nuovo; informazione ritirata → sparisce; pagine private e tipi non collegati non promossi; promozione ripetuta senza nuove versioni |
| Ciclo interrotto → ripresa la notte dopo | SUPERATO ([test](../../packages/hive/test/dream.test.ts)): con un orologio simulato e budget di 60 minuti il ciclo si ferma a metà, dorme fino alle 22:00 del giorno dopo (`dream_runs` in pausa sul passo giusto), riprende da lì e conclude; i passi già fatti non si ripetono (un duplicato unito una volta, un link aggiunto, una sintesi); rapporto in `vault_log`, indici generati; lo spazio promuove l'azienda unita |

Altre prove: API dei curatori via HTTP (solo chi cura vede e decide, unione con link aggiornati, celle collegate solo dagli admin, pagine generate che rifiutano le modifiche con 409); test Playwright della coda nei 4 temi (37 test in tutto, superati).

Prova con i modelli reali sui dati dimostrativi: il ciclo della cella ha calcolato i vettori con l'embedding locale e scritto una sintesi con il modello di chat da 27B (252 token); il ciclo dello spazio «Clienti» ha confermato 12 pagine d'alveare senza nuove versioni e 1 conflitto aperto (l'altro era stato deciso dall'interfaccia).

## Problemi trovati e corretti

1. **Il modello di chat ragionava fino a esaurire i token.** Qwen3.8 ha una modalità di ragionamento: con 300 token di limite restituiva una risposta vuota (`finish_reason: length`); `/no_think` nel testo non basta. `ChatRequest.thinking: false` manda `chat_template_kwargs.enable_thinking = false` a llama-server: la sintesi arriva in 55 token. Il compilatore della fase 3 continua a usare il ragionamento.
2. **Microsecondi persi.** Un parametro `timestamptz` passa da una `Date` di JavaScript (millisecondi): `claims_at` risultava sempre più vecchio di `updated_at` e ogni notte rileggeva tutte le pagine. Il tempo ora torna al database come testo.
3. **Soglia dei trigrammi per connessione.** `set_limit` vale per la connessione: soglia e query della deduplica ora stanno nella stessa transazione.
4. **Modifiche perse.** Le pagine d'alveare mostravano «Modifica», ma la promozione le riscrive: ora sono in sola lettura nell'API e nell'interfaccia.

## Da sapere

1. **Estrazione deterministica dei claims.** Funziona sulle pagine scritte con la convenzione `Etichetta: valore` del compilatore. Le frasi libere diventano note, mai conflitti. Un'estrazione con il modello per le frasi libere è possibile, ma renderebbe i claims meno stabili da una notte all'altra.
2. **La promozione rilegge tutti i claims dello spazio** a ogni lotto. Va bene fino a decine di migliaia di soggetti; oltre servirà un indice per soggetto e lotti per soggetto.
3. **REINDEX degli HNSW e partizioni future** non sono fatti: una partizione per vault nasce con il vault; la degradazione degli indici vettoriali sarà misurata in fase 8.
4. **Dati dimostrativi**: le schede dei clienti sono ora nelle celle di Nome CognomeBBB e di Nome CognomeIII; lo spazio «Clienti» le riceve con la promozione (2 conflitti voluti nella coda di Nome CognomeBBB). `npx tsx scripts/dream-now.ts demo-cella` avvia un ciclo subito.
5. **Configurazione locale cambiata**: in `.env` `LOCAL_MODELS_ENABLED=true` e `LOCAL_LLAMA_BIN` puntano al llama-server di Docker Desktop. I modelli sono in `data/models/` (ignorata da git).

# Fase 6 — server MCP, skill e plugin per l'agente cloud

Data: 2026-10-28

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Server MCP | `@cb/mcp`, montato su `POST /mcp` (streamable HTTP senza sessione: ogni richiesta crea un server legato all'account, qualunque processo risponde). Solo account API con chiave Bearer e ambito `read`. SDK ufficiale `@modelcontextprotocol/sdk` 1.32.1 |
| 9 tool | `brain_overview`, `brain_search`, `brain_read` (pagine e documenti non compilati, a budget), `brain_neighbors`, `brain_timeline` (entità o periodo), `brain_source` (testo estratto di una citazione, mai il file), `brain_ask` (risposta del modello locale con citazioni, citazioni a id non forniti segnalate), `brain_capture` (nota nella cartella `inbox/`), `brain_propose_edit` (proposta in coda ai curatori). Ogni elemento dice il suo costo in token; ogni tool accetta un budget |
| Resource e prompt | `brain://<vault>/index`, `brain://<vault>/llms.txt`, `brain://<vault>/page/<id>`; prompt `cosa-sappiamo-di`, `stato-cliente`, `prepara-riunione` |
| Filtro di classificazione | Il lettore MCP ha clearance al massimo «interno» (`MCP_MAX_CLASSIFICATION`), qualunque sia quella dell'account; RLS la applica di nuovo. Gli indici per agenti sono generati per il lettore sotto RLS: la copia salvata dal ciclo notturno (con tutte le pagine) non esce mai, né via MCP né via REST |
| Audit | Letture nel log raggruppato: `page.read` (alimenta «Cosa ha letto l'agente cloud»), `search`, `source.read`, `mcp.<tool>`, tutte con `via: mcp`. Scritture (`mcp.capture`, `mcp.propose_edit`) e approvazioni (`curator.apply`) scritte subito |
| Proposte di modifica | Nuovo tipo `proposal` nella coda dei curatori (migrazione 010): differenze riga per riga, «Approva e applica» (serve il permesso di scrittura sul vault) o «Rifiuta». Se la pagina cambia dopo la proposta, la proposta decade |
| Skill e plugin | `skills/hivevault-query` (flusso overview → search → read a budget → neighbors/timeline → source; come citare; quando dire che la memoria non lo sa), `skills/hivevault-ingest` con il client `scripts/brain.mjs` (Node 18+, senza pacchetti); `.claude-plugin/` rende il repository un plugin per agenti cloud che registra il server MCP (`$HIVEVAULT_URL/mcp`, chiave in `$HIVEVAULT_API_KEY`) e le skill |
| `llms.txt` | `GET /llms.txt` pubblico: come collegarsi e quali tool esistono (nessun dato) |
| Dati dimostrativi | `scripts/seed-demo.ts` crea una chiave per l'account `agent-demo` (lettura e scrittura, clearance interno) in `data/dev-demo.json`, per collegare un agente cloud al server di sviluppo |

## Verifica

| Criterio di accettazione | Esito |
|---|---|
| recall@5 ≥ 0,85 | SUPERATO: **0,992** con il riordino di 20 candidati (valore predefinito), 0,962 con 10. Corpus sintetico (seed 42): 388 documenti, 131 domande con le fonti attese, indicizzati con il modello di embedding locale; ricerca come `brain_search` per un account API ([rapporto 20](phase6-eval-rerank20.md), [rapporto 10](phase6-eval-rerank10.md)) |
| Nessuna pagina `riservato` restituita a clearance `interno` | SUPERATO: 10 documenti «canarino» `riservato` caricati nello stesso vault, account API con clearance `segreto`: 0 restituiti dalla ricerca mirata e dalla lettura per id, 0 risposte su 131 con elementi sopra «interno». Test HTTP con il client MCP ufficiale: pagine `riservato` e `segreto` assenti da ricerca, lettura, risorse e `llms.txt` |

| Misura (eval, 131 domande) | 20 candidati | 10 candidati |
|---|---|---|
| recall@5 | 0,992 | 0,962 |
| hit@1 | 0,733 | 0,748 |
| MRR | 0,833 | 0,837 |
| Token medi per risposta di `brain_search` | 838 | 857 |
| Latenza mediana (reranker su CPU) | 5,3 s | 2,7 s |

`brain_ask` con il modello di chat reale (Qwen3.8 27B, 30 domande): 90% di risposte corrette (per gli elenchi almeno l'80% degli elementi), 0 citazioni a id non forniti, 58% delle citazioni contiene il valore atteso, 8,3 s in media. Le 5 contraddizioni volute del corpus: in 5 risposte su 5 entrambi i valori sono riportati con la loro fonte, ma solo 1 lo dice esplicitamente. Le 3 risposte sbagliate sono elenchi (progetti di una persona) sparsi su molti documenti: per queste domande la skill indica `brain_neighbors`.

Test: 181 unitari e di database (3 nuovi file: server MCP con il client ufficiale, `llms.txt`, proposte), 41 Playwright nei 4 temi (nuovo: approvazione di una proposta dell'agente cloud dalla coda).

## Problemi trovati e corretti

1. **Indici con titoli riservati.** L'indice salvato dal ciclo notturno è scritto con tutti i permessi: servito così, avrebbe mostrato titoli e sintesi di pagine `riservato` a chi non può leggerle (via MCP e via `GET /api/vaults/:id/index/:name`). Ora l'indice è generato per il lettore sotto RLS; la copia salvata serve solo a esportazioni e amministratori.
2. **Punteggio dell'eval.** La prima versione chiedeva la frase attesa intera («SQL Server: vincolo dell'infrastruttura…») e contava 70% di risposte corrette; con il valore chiave e gli elementi degli elenchi le risposte corrette sono 90%. Il testo di ogni risposta è salvato per controllo.
3. **Lock esauriti con molti vault.** Il database di test aveva accumulato 1.100 vault, quindi 1.100 partizioni dei chunk con i loro indici: le query su molte partizioni esaurivano la tabella dei lock («out of shared memory», `max_locks_per_transaction` = 64). Con una cella per persona anche la produzione avrà migliaia di vault: `docker-compose.yml` porta il limite a 1024. La creazione del database di test ora tollera la gara tra i processi di test.
4. **Script senza `.env`.** `seed-demo`, `dream-now` e l'eval non caricavano `.env` (lo fa il punto d'ingresso del server): i modelli locali risultavano spenti. Ora lo caricano come primo import.

## Da sapere

1. **Antivirus e HTTP locale.** Su questa macchina il Web Shield di Avast (`wsc_proxy.exe`) intercetta anche l'HTTP verso `127.0.0.1` e riscrive le risposte dei server Node: toglie `Content-Length`, dichiara `transfer-encoding: chunked` e lascia il corpo non codificato. I browser lo tollerano, i client rigorosi (fetch di Node, usato dall'agente di programmazione e dal client MCP) no. Il server è corretto (verificato a livello di socket); i test MCP passano per `app.inject`. Per usare l'agente di programmazione con il server di sviluppo su questa macchina serve un'eccezione per l'indirizzo nell'antivirus. Va scritto nella guida di installazione insieme alla nota della fase 2 sul TLS.
2. **Latenza del riordino.** Il reranker 0,6B su CPU costa circa 0,25 s per candidato: con 20 candidati `brain_search` impiega circa 5 s. `MCP_RERANK_TOP=10` dimezza il tempo con una piccola perdita di recall. Un reranker su GPU o su un host dedicato (D10) toglierebbe il compromesso.
3. **Contraddizioni.** Il modello riporta i valori discordi ma raramente lo dice in modo esplicito; nelle pagine compilate le contraddizioni sono già segnalate dal ciclo notturno (`[!conflict]`, coda dei curatori), quindi la via consigliata all'agente cloud resta search + read.
4. **`npm audit`.** Restano avvisi su dipendenze di sviluppo già presenti (vitest, plugin Svelte, pptxgenjs del generatore di corpus): non sono nel server e la correzione richiede aggiornamenti maggiori. Da rivedere in fase 8.
5. **Compilazione dell'eval.** L'eval misura la ricerca sui documenti indicizzati (I2) senza compilarli in pagine: compilare 388 documenti con il modello da 27B richiederebbe ore. La misura su pagine compilate arriverà con un corpus compilato di notte dal ciclo notturno.

# Fase 7 — console di amministrazione e dashboard

Data: 2026-11-02

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Console (`#/admin/…`) | 11 sezioni per gli amministratori: utenti (creazione con link di attivazione, ruolo, livello, sospensione, azzeramento TOTP, chiusura delle sessioni, passkey e chiavi di firma), account API (chiave mostrata una volta, rotazione, revoca, indirizzi ammessi, scadenza), vault e spazi (impostazioni, celle che alimentano uno spazio, ciclo notturno subito, esporta e importa zip, eliminazione con lo slug come conferma), matrice dei permessi account × vault, sorgenti di tutti i vault (riprova, compila, elimina con i file contenuti e gli originali cifrati), import massivi, task (conteggi, giornale, riprova, annulla), modelli, audit con ricerca, impostazioni, backup. Ogni modifica è scritta subito nel log di audit |
| Pagina «Modelli» | Stato, latenza, elementi al secondo, richieste ed errori di ogni endpoint del dispatcher; prova di un endpoint (health, identità del modello, una richiesta minima); code per priorità. Processi locali: avvia, ferma, riavvia, log; thread e orario (sempre, fascia, su richiesta) applicati senza riavvio del server. Endpoint remoti aggiunti e rimossi dalla console (salvati nelle impostazioni, ammessi dall'egress guard) |
| Impostazioni | Tabella `settings` (migrazione 011) sopra i valori del file `.env`: finestra e budget del ciclo notturno (letti a ogni passo e a ogni risveglio del pianificatore), classificazione predefinita dei nuovi vault, testo dell'avviso sull'agente cloud, processi locali, endpoint remoti |
| Storico delle pagine | «Ripristina questa versione»: la versione scelta diventa una nuova versione e lo storico resta intatto (`POST /api/pages/:id/restore`, audit `page.restore`) |
| Metriche | Registro in processo (`@cb/shared`: contatori, gauge, istogrammi in ms). Ogni minuto ogni processo scrive la sua parte in `metrics_1m` (partizioni giornaliere, 14 giorni). Un solo processo, eletto con un advisory lock, campiona i gauge (host, database, task, sorgenti, modelli, accessi; partizioni e salute della memoria ogni 15 minuti) e calcola i rollup `metrics_1h` (400 giorni) e `metrics_1d`. Strumentati: HTTP, ricerca per ramo, dispatcher, fasi dei task, lettura dei documenti, ciclo notturno, promozioni, audit, egress bloccato |
| Query dei pannelli | `POST /api/admin/metrics/query` (fino a 40 query per richiesta). Il server sceglie la tabella dal periodo (fino a 36 ore al minuto, fino a 45 giorni all'ora, poi al giorno) e restituisce circa 300 punti per serie. Aggregazioni: rate, sum, avg, max, min, last, count e i percentili p50, p95, p99 dai bucket degli istogrammi. Le tabelle dei pannelli sono in `GET /api/admin/stats/:name` (query lente da `pg_stat_statements`, partizioni, copertura, errori dei parser, cicli notturni, alveare, liste della salute, sicurezza) |
| Dashboard (`#/dashboard/…`) | Le 10 di §8.4: Panoramica, Ingestion e import, Ricerca, Salute della memoria, Alveare, Dream cycle, Modelli, Database, Accessi e sicurezza, Host. Periodo globale (da 1 ora a 90 giorni), aggiornamento automatico, variabile `$spazio`, griglia di 12 colonne con pannelli spostabili e ridimensionabili (mouse o tastiera, layout salvato per persona), vista tabella per ogni grafico, soglie con icona e testo, collegamenti agli elenchi filtrati della console |
| Grafici | SVG propri sui token dei temi: un solo asse da zero, linee da 2 px, interruzioni dove mancano dati, mirino e tooltip, legenda che nasconde una serie senza cambiare i colori delle altre, al massimo 6 serie colorate (le altre in «Altri»). Le serie 4-6 si aggiungono alle 3 originali; lo script di controllo della palette le ha verificate sui 4 temi (luminosità, croma, separazione per daltonismo, contrasto) |
| Prometheus | `GET /metrics` con `METRICS_TOKEN` (Bearer) o con la sessione di un amministratore: contatori cumulativi, gauge, istogrammi con bucket `le` |

## Verifica

| Criterio di accettazione | Esito |
|---|---|
| Ogni entità gestibile dalla UI | SUPERATO: utenti, account API, chiavi e passkey, sessioni, vault e spazi, collegamenti dell'alveare, permessi, sorgenti, import, task, pagine (modifica, storico, ripristino, unione dalla coda), coda dei curatori, modelli locali e remoti, impostazioni, backup ed esportazione. Test Playwright nei 4 temi: creazione di un account API con chiave mostrata una volta, permesso dalla matrice, impostazioni salvate, apertura di ogni sezione |
| Dashboard fluide con 7 giorni di dati al minuto | SUPERATO: 7 giorni al minuto per 264 serie (1.665.183 righe, 269 MB con i rollup; scrittura a 52.000 righe/s, rollup orario di 7 giorni in 3,9 s). La misura esegue insieme tutte le query di una dashboard, come la pagina: mediana peggiore **129 ms** (Ingestion, 24 ore al minuto), p95 peggiore 137 ms; con 7 giorni al massimo 72 ms, con 30 giorni al massimo 20 ms. Il rapporto è in `bench/out/` (non versionato); `npx tsx bench/phase7/metrics-bench.ts` ripete la misura |

| Periodo (10 dashboard) | Tabella | Mediana peggiore | p95 peggiore |
|---|---|---|---|
| 1 ora | 1m | 30 ms | 33 ms |
| 24 ore | 1m | 129 ms | 137 ms |
| 7 giorni | 1h | 58 ms | 72 ms |
| 30 giorni | 1h | 20 ms | 20 ms |

Test: 191 unitari e di database. Nuovi: registro, quantili, scrittura, rollup e query, elezione del processo leader; API della console con ogni pannello eseguito sullo schema reale, Prometheus, task, impostazioni, modelli, eliminazione delle sorgenti, esportazione e importazione di un vault; ripristino di una versione. 58 test Playwright nei 4 temi. Nuovi: console, dashboard con un pannello spostato da tastiera e il layout salvato, axe WCAG 2.1 AA su 7 viste della console e delle dashboard.

## Problemi trovati e corretti

1. **Etichette codificate due volte.** Le etichette delle serie passate come `jsonb[]` arrivavano come stringhe JSON dentro il JSON. Ora passano come `text[]` con il cast in SQL.
2. **Pagina bianca dopo un nuovo build.** Una scheda aperta chiedeva un file JavaScript del build precedente. Il server rispondeva con la pagina dell'app (HTML) e il browser si fermava. Ora un file mancante (un percorso con estensione) riceve un 404.
3. **Console nel bundle principale.** Console e dashboard aggiungevano 130 KB al caricamento di ogni utente. Ora si caricano solo quando un amministratore le apre: il bundle principale passa da 398 a 270 KB.
4. **Spazio per le dashboard.** A 1440 px la griglia aveva solo 574 px (barra laterale, pannello destro, elenco delle dashboard). Il pannello destro mostra struttura e collegamenti della pagina attiva, quindi sulla console e sulle dashboard non si apre. La griglia passa a 6 o a 1 colonna quando lo spazio è poco.
5. **Contrasto dei badge.** Il testo colorato sui fondi tenui scendeva a 4,3:1 nel tema Carta. Ora il testo usa il colore del testo; il tono è nel fondo e in un punto.
6. **Test del ciclo notturno legato alla data.** Il test usava la notte del 28 ottobre 2026: dopo quella data il motore svegliava subito il task in pausa. Ora il test usa una notte dell'anno successivo.

## Da sapere

1. **`/metrics` mostra un solo processo.** Prometheus legge i contatori del processo che risponde. Con più processi, leggi ogni processo oppure usa le dashboard, che sommano tutti i processi dal database.
2. **Rete dell'host solo su Linux.** Il pannello «Rete» legge `/proc/net/dev`: su Windows (sviluppo) è vuoto.
3. **Backup continuo del database.** La pagina «Backup» esporta i vault in Markdown e mostra gli spazi usati. pgBackRest e il ripristino a un istante preciso sono nella fase 8.
4. **Amministratore di sviluppo.** `npx tsx scripts/dev-admin.ts` crea `admin` e salva il segreto TOTP in `data/dev-admin.json` (non versionato).

# Fase 8 — hardening e rilascio

Data: 2026-11-02

## Cosa c'è

| Parte | Dettaglio |
|---|---|
| Revisione di sicurezza | OWASP ASVS 4.0.3 livello 2, capitolo per capitolo, con la prova di ogni requisito: [docs/sicurezza/asvs-l2.md](../sicurezza/asvs-l2.md). 7 problemi trovati e corretti (sotto) |
| Backup | Immagine PostgreSQL con pgBackRest (`docker/postgres`): archiviazione continua del WAL (al massimo 5 minuti di modifiche perse), repository cifrato AES-256 con compressione zstd, 2 backup completi conservati. `npm run backup -- stanza\|full\|diff\|info\|check\|verify` |
| Ripristino verificato | `npm run backup -- verify`: ripristino a un istante preciso in un contenitore e in un volume temporanei, controllo dei dati, pulizia. Timer mensile nello script di installazione |
| Test di carico | k6 (immagine ufficiale `grafana/k6`), 40 utenti per 3 minuti: ricerca, lettura con budget, pagina completa, recenti (`bench/phase8/`) |
| Profilazione | `pg_stat_statements` e `EXPLAIN ANALYZE`: due liste della UI corrette con indici parziali (migrazione 012) |
| Host dei modelli remoto | Embedding (porta 8080) e rerank (porta 8081) collegati con chiave API, verificati dal dispatcher (stesso modello dei vettori salvati) e misurati (`bench/phase8/models-hosts.ts`) |
| Installazione | `scripts/install.sh`: controlli, `.env` con segreti casuali, build, database, backup, servizio systemd e timer dei backup |
| Documentazione (ASD-STE 100) | [installazione](../guide/installazione.md), [operatore](../guide/operatore.md), [amministratore](../guide/amministratore.md), [utente](../guide/utente.md) |
| Checklist di rilascio | [docs/RILASCIO.md](../RILASCIO.md): voci di sviluppo verificate, voci di installazione da spuntare sul server |

## Verifica

| Criterio di accettazione | Esito |
|---|---|
| Checklist di rilascio completa | SUPERATO per le voci di sviluppo (qualità, sicurezza, prestazioni, backup): tutte verificate con il comando o il test indicato. Le voci di installazione (HTTPS, chiavi copiate fuori dal server, repository di backup su un altro disco) si spuntano sul server di produzione |

| Misura | Risultato | Obiettivo (piano §0.2) |
|---|---|---|
| Ricerca ibrida senza rerank, fuori dalla cache, 40 utenti | **p95 153 ms** (233 ricerche; mediana 112 ms) | < 200 ms |
| Lettura di una pagina con budget, 40 utenti | **p95 14 ms** (3.225 letture) | < 20 ms |
| Pagina completa / recenti | p95 20 ms / 14 ms | — |
| Ricerca dalla cache | p95 12 ms | — |
| Errori HTTP sotto carico | **0** su 7.970 richieste (35 richieste/s) | < 1% |
| Backup completo del database di sviluppo (5,4 GB) | 15 s, 1 GB cifrato e compresso | — |
| Ripristino a un istante preciso | **11 s** di restore, 26 s in tutto; il segno prima dell'istante c'è, quello dopo no; conteggi di 7 tabelle identici (1,1 milioni di sorgenti e di vettori), 0 pagine orfane | dati identici |
| Inbox / «Da rivedere» (1,1 milioni di sorgenti) | da 95 / 77 ms a **0,15 / 0,02 ms** | — |

| Host dei modelli (stessi modelli 0,6B Q8_0) | Embedding (chunk di 300–400 parole) | Rerank di 20 candidati (mediana) |
|---|---|---|
| Host remoto (CPU) | 2,5 chunk/s | 2,0 s |
| Questo PC (processi locali, CPU) | 1 chunk/s | 5,1 s |

Test: 193 unitari e di database (nuovi: redazione dei log, endpoint dei modelli solo privati, zip bomb, header e `no-store`, ricerca con vault indicizzati da un altro modello, schemi dei tool MCP con zod 4), 58 Playwright nei 4 temi.

## Problemi trovati e corretti

1. **La ricerca si fermava con un vault indicizzato da un altro modello.** Il primo test di carico ha dato il 100% di errori sulle ricerche: 7 vault dei benchmark della fase 3 hanno 1,1 milioni di vettori del modello finto (16 dimensioni) e la ricerca confrontava il vettore della domanda (1024 dimensioni) anche con quelli. Lo stesso accadrebbe in produzione dopo un cambio del modello di embedding, finché i vettori vecchi non sono ricalcolati. Ora i rami vettoriali confrontano solo i vettori del modello della domanda (invariante 3). Il nome del modello va normalizzato come fa l'indicizzatore: senza, il filtro avrebbe escluso in silenzio tutti i vettori. Un test riproduce il guasto (fallisce senza la correzione con lo stesso errore).
2. **Endpoint dei modelli verso Internet.** Un amministratore poteva aggiungere dalla console un endpoint su un indirizzo pubblico e il testo dei documenti sarebbe uscito dalla rete (invariante 1). Ora l'indirizzo deve risolversi solo su indirizzi privati.
3. **Zip bomb nell'import dei vault.** Nessun limite sulla dimensione decompressa; ora 50.000 file, 50 MB per file e 2 GB in totale, contati durante la decompressione.
4. **Ripristino non funzionante al primo tentativo.** La prova di ripristino ha trovato due difetti della procedura: il server ripristinato legge il WAL dal repository e gli servono la passphrase e il volume del repository; e il recupero rifiuta impostazioni (`max_connections` e altre) più basse di quelle del server originale. Lo script e la guida dell'operatore ora li gestiscono.
5. **Due liste della UI leggevano tutta la tabella delle sorgenti** per ogni apertura (Inbox e «Da rivedere», lettura parallela di 1,1 milioni di righe). Indici parziali nell'ordine di ogni lista; per un utente con un solo vault il piano resta sull'indice del vault (controllato).
6. **Sicurezza minore**: risposte dell'API memorizzabili dal browser (`no-store` aggiunto), mancavano `Permissions-Policy` e CORP, il logger poteva scrivere segreti (ora redatti), token di `/metrics` confrontato senza tempo costante, `zod` con un avviso alto (aggiornato a 4.6.7, schemi dei tool verificati).
7. **Reranker locale con batch di 512 token.** Una coppia domanda + documento più lunga falliva; la ricerca invia solo titolo e frammento (molto meno), ma il processo locale ora ha lo stesso batch del processo di embedding (2048).
8. **Test end-to-end con una gara.** La matrice dei permessi salva subito; il test ricaricava la pagina prima della risposta del server e falliva in 1 tema su 4. Ora attende la risposta.

## Da sapere

1. **Repository dei backup sullo stesso disco.** In sviluppo il volume `pgbackrest` è sullo stesso disco del database. In produzione montalo su un altro disco o aggiungi un secondo repository (`repo2`): voce 4.3 della checklist.
2. **Prima ricerca dopo un riavvio.** La prima ricerca di ogni connessione prepara piani e statement e scalda il modello: 2–3 s una volta sola, poi 50–110 ms.
3. **Dati dei benchmark nel database di sviluppo.** I 7 vault `crash3-…` e `imp3-…` (fase 3) restano con i vettori del modello finto: non disturbano più la ricerca, ma rallentano di circa 40 ms le ricerche di chi li può leggere (lettura sequenziale delle loro partizioni). Si possono eliminare dalla console.
4. **Indici della migrazione 012 su tabelle grandi.** La migrazione gira in una transazione: su decine di milioni di sorgenti la costruzione degli indici blocca le scritture. In quel caso creali prima a mano con `CONCURRENTLY` (istruzioni nel file).
5. **Dipendenze con avvisi moderati.** 9 avvisi in due catene non raggiungibili (`glob` in `@fastify/static`, `archiver` in `exceljs`): motivazione nella revisione ASVS, da ricontrollare a ogni rilascio.
6. **Ingestion continua di 24 ore.** Saltata in questa fase su richiesta; il benchmark della fase 3 (crash e import di 1 milione di file) resta la misura di riferimento.
7. **Credenziali dell'host dei modelli.** Il server usa solo gli endpoint HTTP dell'host remoto con la chiave API in `.env`; l'accesso SSH non serve.
