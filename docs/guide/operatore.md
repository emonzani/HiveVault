# Guida dell'operatore

Questa guida è per chi gestisce il server: servizio, backup, ripristino, aggiornamenti, controllo. Per installare il server, leggi la [guida all'installazione](installazione.md).

## 1. Servizio

| Azione | Comando |
|---|---|
| Stato | `systemctl status hivevault` |
| Log | `journalctl -u hivevault -f` (una riga JSON per evento) |
| Riavvio | `sudo systemctl restart hivevault` |
| Database | `docker compose ps` (servizi `postgres` e `pgbouncer`) |

Il server ferma i task in modo ordinato con `SIGTERM`. I task durevoli (letture dei documenti, import, ciclo notturno) riprendono dall'ultima fase salvata dopo il riavvio. Non serve fermare il lavoro prima di un riavvio.

I log non contengono segreti: i valori di token, codici, chiavi e cookie sono sostituiti da `[nascosto]`.

## 2. Backup

### 2.1 Cosa salvare

| Dato | Dove | Come |
|---|---|---|
| Database (pagine, metadati, vettori, utenti, audit) | Volume `pgdata` | pgBackRest: archiviazione continua del WAL + backup completi e differenziali |
| Documenti originali (cifrati) | `data/blobs/` | Copia dei file con lo strumento di backup dell'azienda (sono già cifrati, anche i nomi dei file: §4.4) |
| Chiave principale | `data/.master-key` | Copia offline, una volta (vedi installazione, §3) |
| Configurazione | `.env` | Copia offline, dopo ogni modifica |
| Esportazioni dei vault | `data/exports/` | Facoltativo: Markdown leggibile senza il server |

### 2.2 pgBackRest

Il database archivia il WAL in modo continuo nel repository di pgBackRest (volume `pgbackrest`, cifrato con AES-256). Con `archive_timeout=300` si perdono al massimo 5 minuti di modifiche.

I timer di systemd fanno:

| Timer | Quando | Comando |
|---|---|---|
| `hivevault-backup-full` | Domenica 02:30 | `npm run backup -- full` |
| `hivevault-backup-diff` | Lunedì–sabato 02:30 | `npm run backup -- diff` |
| `hivevault-backup-verify` | Il giorno 1 di ogni mese, 04:00 | `npm run backup -- verify` |

Il repository conserva 2 backup completi e il WAL tra di essi: circa 2 settimane di ripristino a un istante preciso.

**Il repository è sullo stesso server.** Per resistere alla perdita del disco, monta il volume `pgbackrest` su un altro disco, oppure aggiungi un secondo repository (`repo2`, S3 o SFTP aziendale) in `docker/postgres/pgbackrest.conf`.

Controlla lo stato:

```bash
npm run backup -- info
npm run backup -- check
systemctl list-timers 'hivevault-*'
```

### 2.3 Prova di ripristino

```bash
npm run backup -- verify
```

Il comando:
1. scrive un segno nel database e fa un backup differenziale;
2. sceglie un istante, poi scrive un secondo segno;
3. ripristina il backup in un contenitore e in un volume temporanei, fino a quell'istante;
4. controlla che il primo segno ci sia e il secondo no, e che i conteggi di 7 tabelle siano uguali;
5. elimina il contenitore e il volume temporanei.

Il risultato è in `bench/out/backup-verify-<id>.json`. Il timer mensile esegue la prova da solo. Se la prova non riesce, il servizio `hivevault-backup-verify` è in stato `failed`: controllalo con `systemctl --failed`.

## 3. Ripristino

### 3.1 Ripristino completo (disco perso o database danneggiato)

1. Ferma il server: `sudo systemctl stop hivevault`.
2. Ferma il database. Se il volume dei dati esiste ancora, copialo prima del ripristino: non cancellare la copia finché il ripristino non è controllato.

   ```bash
   docker compose stop postgres
   docker run --rm -v hivevault_pgdata:/from:ro -v hivevault_pgdata_old:/to alpine sh -c 'cp -a /from/. /to/'
   ```

3. Ripristina (ultimo stato disponibile). `--delta` riscrive solo i file diversi dal backup:

   ```bash
   docker compose run --rm -u postgres postgres \
     pgbackrest --stanza=brain --delta restore
   ```

   Per un istante preciso aggiungi `--type=time --target="2026-11-02 10:30:00+01" --target-action=promote`.

4. Avvia il database: `docker compose up -d postgres`. Il database applica il WAL e poi accetta connessioni.
5. Controlla: `npm run db:migrate` (nessuna migrazione da applicare) e accedi all'interfaccia.
6. Avvia il server: `sudo systemctl start hivevault`.
7. Fai subito un backup completo: `npm run backup -- full`.

Il server ripristinato deve avere impostazioni uguali o maggiori dell'originale per `max_connections`, `max_locks_per_transaction`, `max_worker_processes`, `max_wal_senders`, `max_prepared_transactions`. Il file `docker-compose.yml` le contiene già.

### 3.2 Ripristino di un solo vault

Usa un punto di ripristino: **Console → Vault e spazi → vault → Punti di ripristino → Ripristina**. Tutte le pagine tornano a quel momento; lo stato attuale diventa un nuovo punto automatico, così puoi annullare.

Senza un punto di ripristino, usa l'esportazione Markdown: **Importa zip**. Le pagine con lo stesso percorso ricevono una nuova versione. Lo storico resta intatto.

### 3.3 Ripristino di una pagina

**Pagina → Storico → versione → Ripristina questa versione**. La versione scelta diventa una nuova versione.

## 4. Aggiornamento

### 4.1 Con lo script di aggiornamento (consigliato)

`scripts/deploy.sh` aggiorna il server da un computer di sviluppo, via SSH con chiave. Il codice arriva come archivio di un commit: sul server non servono git né un repository remoto.

```bash
bash scripts/deploy.sh                    # aggiorna al commit attuale
bash scripts/deploy.sh --status           # versioni sul server, servizio, salute
bash scripts/deploy.sh --rollback         # torna alla versione precedente
```

Opzioni: `--target utente@host` (obbligatorio; in alternativa imposta la variabile `DEPLOY_TARGET=utente@host`), `--ref <commit>`, `--keep <n>` versioni conservate (predefinito 3).

Sul server lo script:
1. copia la versione in `~/hivevault/releases/<commit>`;
2. installa le dipendenze e costruisce l'interfaccia mentre la versione attuale resta in servizio;
3. fa un backup differenziale (punto di ripristino);
4. aggiorna l'immagine del database, se è cambiata;
5. ferma il servizio, applica le migrazioni, sposta il collegamento `current` e riavvia;
6. controlla `/api/health`. Se il server non risponde entro 2 minuti, torna da solo alla versione precedente.

`.env` e i dati sono in `~/hivevault/shared/` e valgono per tutte le versioni.

Il ritorno alla versione precedente non annulla le migrazioni del database. Se una migrazione causa un problema, ripristina il backup fatto dallo script (§3.1, ripristino a un istante prima dell'aggiornamento).

Dopo il primo avvio di una versione con i nomi cifrati dei documenti originali, non tornare a una versione precedente (§4.4).

Prima installazione con lo stesso script:

```bash
bash scripts/deploy.sh --install --host brain.azienda.local --port 3700
```

Senza `sudo` senza password, lo script installa servizi *utente* di systemd per l'utente del servizio (`systemctl --user`, con linger attivo). I comandi diventano `systemctl --user status hivevault` e `journalctl --user -u hivevault`.

### 4.2 HTTPS

`--tls` installa (o rinnova) il certificato del server e passa il servizio in HTTPS:

```bash
bash scripts/dev-ca.sh brain.azienda.local    # oppure un certificato della CA aziendale
bash scripts/deploy.sh --tls certificato.pem chiave.pem
```

Lo script:
1. copia certificato e chiave in `~/hivevault/shared/tls/` (la chiave con permessi 600);
2. controlla che la chiave corrisponda al certificato;
3. salva una copia di `.env` (`.env.bak-<data>`), imposta `TLS_CERT_FILE`, `TLS_KEY_FILE` e `PUBLIC_URL` in `https`;
4. riavvia e controlla `/api/health`. Se il server non risponde, rimette la configurazione di prima.

Ogni computer client deve considerare attendibile la CA che ha firmato il certificato (`data/tls/ca.pem` per la CA locale). Un antivirus che ispeziona l'HTTPS (per esempio Avast Web Shield) deve avere un'eccezione per l'indirizzo del server, altrimenti il browser vede il certificato dell'antivirus. Le passkey richiedono un nome di dominio: con un indirizzo IP l'accesso usa il codice TOTP.

### 4.3 A mano

1. Leggi le note della versione.
2. Fai un backup completo: `npm run backup -- full`.
3. Aggiorna il codice (per esempio `git pull`).
4. Installa e costruisci:

   ```bash
   npm ci
   npm run web:build
   docker compose build postgres && docker compose up -d postgres
   npm run db:migrate
   ```

5. Riavvia: `sudo systemctl restart hivevault`.
6. Controlla **Dashboard → Panoramica** e la pagina **Modelli**.

Le migrazioni sono file SQL numerati, applicati una volta sola. Non modificare una migrazione già applicata: aggiungine una nuova.

### 4.4 Nomi cifrati dei documenti originali (senza ritorno)

Il nome di ogni file in `data/blobs/` è un HMAC dell'impronta SHA-256 del documento, con una chiave per vault derivata dalla chiave principale. Senza la chiave, una copia di `data/blobs/` non mostra quali documenti noti contiene. Le versioni precedenti usavano come nome l'impronta SHA-256 (`<vault>/ab/cd/<sha256>`).

1. Il primo avvio della nuova versione cambia i nomi vecchi in nomi cifrati. Il server fa il cambio in background, dopo l'avvio: risponde subito a `/api/health` e agli utenti. Durante il cambio, il server legge i file con il nome vecchio e con il nome nuovo.
2. Il log del servizio mostra l'avanzamento (`blob name migration in progress`) e il risultato (`blob name migration done`) con i numeri dei file. Il log non contiene nomi di file. Se il servizio si ferma prima della fine, l'avvio successivo continua il cambio.
3. Se la chiave principale non apre i file di un vault, il server non cambia i nomi di quel vault e scrive un avviso con l'id del vault (`the master key does not open its blobs`). Il server continua a leggere i file con il nome vecchio. Controlla `BRAIN_MASTER_KEY` (o `data/.master-key`) e riavvia il servizio.
4. Il cambio è senza ritorno: le versioni precedenti non leggono i nomi cifrati. Dopo il primo avvio non usare `bash scripts/deploy.sh --rollback` e non installare a mano una versione precedente. Se lo script di aggiornamento torna da solo alla versione precedente, cerca `blob name migration` nel log. Se il cambio è cominciato, aggiorna di nuovo alla nuova versione.
5. I backup di `data/blobs/` fatti prima dell'aggiornamento conservano i nomi vecchi. La nuova versione legge questi file dopo un ripristino e cambia i loro nomi all'avvio successivo. Questi backup mostrano ancora quali documenti noti contiene ogni vault: proteggili come i dati del server, oppure sostituiscili con una nuova copia dopo il cambio.

## 5. Controllo

### 5.1 Dashboard

**Dashboard** (solo amministratori) mostra 10 pannelli: Panoramica, Ingestion, Ricerca, Salute della memoria, Alveare, Ciclo notturno, Modelli, Database, Accessi e sicurezza, Host. Un pannello con «Da controllare» o «Critico» ha passato una soglia: «Apri →» porta all'elenco filtrato.

| Segnale | Cosa fare |
|---|---|
| Task falliti | **Console → Task**: leggi l'errore, poi «Riprova» |
| Ricerca p95 alta | Pannello «Tempo per ramo»: se il ramo lento è `embed` o `rerank`, controlla l'host dei modelli |
| Endpoint non attivi | **Console → Modelli → Prova** |
| Connessioni bloccate | **Console → Audit**, azione `egress.blocked`: un componente ha provato a uscire verso un host non ammesso |
| Letture dalla cache del database basse | Aumenta `shared_buffers` in `docker-compose.yml` |

### 5.2 Prometheus

`GET /metrics` con l'header `Authorization: Bearer <METRICS_TOKEN>`. Ogni processo espone i propri contatori.

### 5.3 Query lente

**Dashboard → Database → Query più lente** mostra le query di `pg_stat_statements`. Per analizzare una query:

```bash
docker compose exec postgres psql -U brain -d brain -c "explain (analyze, buffers) <query>"
```

## 6. Manutenzione automatica

Il ciclo notturno (finestra in **Console → Impostazioni**) fa la manutenzione dei vault: nuove letture con parser aggiornati, vettori mancanti, duplicati, link, sintesi, promozione all'alveare, indici, `VACUUM (ANALYZE)` della partizione quando più del 10% delle righe è morto. Il pianificatore elimina anche i task conclusi (30 giorni) e le righe di audit vecchie (400 giorni).

Il ciclo collega le menzioni e scrive le sintesi solo nelle pagine cambiate dopo il ciclo precedente. Dopo un aggiornamento che cambia queste regole, avvia un ciclo completo sul server:

```bash
cd ~/hivevault/current && npm run cb -- dream --all --full
```

Al posto di `--all` puoi dare uno o più id di vault. Il ciclo parte subito, anche fuori dalla finestra; il limite di minuti e token resta.

Le metriche al minuto restano 14 giorni, quelle orarie 400 giorni.

## 7. Sicurezza operativa

- Cambia `POSTGRES_PASSWORD` e `PGBACKREST_CIPHER_PASS` solo con il database fermo, e aggiorna la copia offline.
- Revoca le chiavi API inutilizzate (**Console → Account API**).
- Controlla ogni mese **Dashboard → Accessi e sicurezza**: accessi negati, host bloccati, chiavi non usate.
- La revisione di sicurezza (OWASP ASVS L2) è in [docs/sicurezza/asvs-l2.md](../sicurezza/asvs-l2.md).
