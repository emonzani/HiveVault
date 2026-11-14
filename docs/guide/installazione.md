# Guida all'installazione

Questa guida installa HiveVault su un server Linux dell'azienda. È scritta per chi installa il server, anche senza conoscere il progetto. Leggila tutta prima di iniziare.

HiveVault è software libero con licenza MIT, fornito «così com'è», senza garanzie. Gli autori non gestiscono le installazioni e non ricevono dati. Chi installa e l'azienda che usa il software ne sono responsabili. Leggi [DISCLAIMER.md](../../DISCLAIMER.md) prima di installare.

## 1. Chi fa cosa

| Figura | Compiti | Dove |
|---|---|---|
| Chi installa e gestisce il server (installatore, operatore) | Prepara il server, installa, configura HTTPS e modelli, conserva le chiavi, fa i backup e gli aggiornamenti, crea il primo amministratore | Questa guida, [guida dell'operatore](operatore.md), [lista §4.1](../sicurezza/privacy.md#41-chi-installa-e-gestisce-il-server), [checklist di rilascio](../RILASCIO.md) |
| Azienda che adotta il software (titolare del trattamento) | Decide gli scopi, fa la DPIA, informa i lavoratori, firma gli accordi, nomina gli amministratori di sistema | [Protezione dei dati personali](../sicurezza/privacy.md), [lista §4.2](../sicurezza/privacy.md#42-azienda-che-adotta-il-software-titolare) |
| Amministratori di HiveVault | Impostano privacy e avvisi, creano utenti, team, vault e permessi | [Guida dell'amministratore](amministratore.md), [lista §4.3](../sicurezza/privacy.md#43-amministratori-di-hivevault) |
| Utenti | Leggono, scrivono, caricano e classificano | [Guida dell'utente](utente.md), [lista §4.5](../sicurezza/privacy.md#45-utenti) |

Prima dell'uso con dati reali, l'azienda completa la sua lista (§4.2 di [privacy.md](../sicurezza/privacy.md)). L'installazione tecnica non basta per usare il sistema in modo conforme.

## 2. Requisiti

| Elemento | Minimo | Nota |
|---|---|---|
| Sistema | Debian 12 o Ubuntu 22.04 (o successivi) | Lo sviluppo usa anche Windows; la produzione usa Linux |
| CPU | 8 core | Più core accelerano la lettura dei documenti e i modelli locali |
| RAM | 32 GB | 64 GB per qualche milione di pagine (piano, §2.5) |
| Disco | 20 GB liberi + 3 volte la dimensione dei documenti | Usa la formula del piano, §2.5 |
| Node.js | 22.19 o successivo | |
| Docker | Engine 24 o successivo, con il plugin `compose` | L'utente del servizio deve essere nel gruppo `docker` |
| Rete | Accesso HTTP agli host dei modelli | Nessun accesso a Internet necessario dopo l'installazione |
| Modelli | Almeno un modello di embedding e uno di rerank (§6) | Il modello di chat è facoltativo |

Prepara anche:

- un nome DNS per il server (per esempio `brain.azienda.local`);
- un certificato TLS per quel nome, oppure la CA aziendale di `scripts/dev-ca.sh`;
- gli indirizzi dei server dei modelli nella rete dell'azienda e la loro chiave API, oppure i file dei modelli per il server stesso (§6).

## 3. Preparare il server

Esegui questi comandi come un utente con `sudo`.

1. Installa i pacchetti di base e Node.js 22 (repository NodeSource):

   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node -v    # deve essere v22.19 o successivo
   ```

2. Installa Docker Engine con il plugin `compose`. Segui la guida ufficiale per la tua distribuzione: <https://docs.docker.com/engine/install/>. Poi controlla:

   ```bash
   docker compose version
   ```

3. Crea un utente per il servizio. Non usare root.

   ```bash
   sudo adduser --disabled-password brain
   sudo usermod -aG docker brain
   ```

4. Se l'utente del servizio non ha `sudo`, attiva il «linger». Così i servizi utente partono anche senza un accesso:

   ```bash
   sudo loginctl enable-linger brain
   ```

## 4. Installazione

1. Entra come utente del servizio e scarica il codice. Usa l'indirizzo del repository o l'archivio della versione che vuoi installare:

   ```bash
   sudo -iu brain
   git clone <indirizzo del repository> hivevault
   cd hivevault
   ```

   In alternativa, da un computer con il repository: `bash scripts/deploy.sh --install --target brain@<server> --host brain.azienda.local`. Lo script copia il codice via SSH ed esegue i passi seguenti (guida dell'operatore, §4).

2. Avvia lo script di installazione:

   ```bash
   bash scripts/install.sh --host brain.azienda.local --port 443 \
     --tls-cert /etc/ssl/brain/cert.pem --tls-key /etc/ssl/brain/key.pem
   ```

   | Opzione | Significato | Predefinito |
   |---|---|---|
   | `--host` | Nome del server; diventa `PUBLIC_URL` (obbligatorio) | — |
   | `--port` | Porta HTTP o HTTPS del server | 3700 |
   | `--tls-cert`, `--tls-key` | Certificato e chiave TLS (file leggibili dall'utente del servizio) | nessuno: HTTP |
   | `--data-dir` | Cartella dei dati (documenti cifrati, chiavi, esportazioni) | `data` nella cartella del codice |
   | `--systemd` | `system` (servizio di sistema, serve `sudo`), `user` (servizio dell'utente), `none` (nessun servizio), `auto` | `auto` |

   Lo script:
   - controlla Node.js, Docker e lo spazio libero;
   - scrive `.env` con password e chiavi casuali (permessi 600) e `MODELS_OFFLINE_MODE=queue`;
   - installa le dipendenze e costruisce l'interfaccia web;
   - avvia PostgreSQL e applica le migrazioni;
   - prepara i backup e fa il primo backup completo;
   - installa il servizio `hivevault` e i timer dei backup (systemd).

   Se esegui di nuovo lo script, il file `.env` esistente resta com'è.

3. Crea il primo amministratore, nella cartella del codice:

   ```bash
   npm run cb -- admin create nome.cognome --name "Nome Cognome"
   npm run cb -- enroll <codice di attivazione>
   ```

   Il secondo comando mostra un codice QR. Leggilo con l'app di autenticazione. Salva i codici di recupero in un posto sicuro. Il primo amministratore è una persona nominata dall'azienda.

## 5. Copia le chiavi fuori dal server

Fai questo passo subito. Senza queste due chiavi i dati non si possono recuperare.

| Chiave | Dove si trova | Senza la chiave |
|---|---|---|
| Chiave principale | `data/.master-key` | I documenti originali cifrati non si leggono più |
| Passphrase dei backup | `PGBACKREST_CIPHER_PASS` in `.env` | I backup del database non si ripristinano |

Conserva le chiavi in una cassaforte delle password o su un supporto offline. Non conservarle sullo stesso disco del server. Annota chi può leggerle: queste persone possono leggere tutti i dati (privacy.md, §3.8).

## 6. Modelli

HiveVault non invia i documenti fuori dalla rete aziendale. I modelli girano sul server o sugli host della rete aziendale. Il server si collega sempre agli host dei modelli che imposti: usa solo host dell'azienda.

| Modello | A cosa serve | Senza il modello |
|---|---|---|
| Embedding | Indicizzazione e ricerca | I documenti restano in attesa e non diventano cercabili |
| Rerank | Ordine dei risultati della ricerca | La ricerca è meno precisa |
| Chat | Compilazione delle pagine, risposte, ciclo notturno con modello | Le compilazioni restano in attesa; ricerca e lettura funzionano |
| OCR (facoltativo) | Scansioni e foto | Le immagini restano con l'avviso «serve OCR» |

**Modelli sugli host della rete.** Imposta in `.env`:

```bash
LLAMA_SERVER_URL=http://modelli.azienda.local:8000      # chat (facoltativo)
REMOTE_EMBED_URLS=http://modelli.azienda.local:8080     # embedding
REMOTE_RERANK_URLS=http://modelli.azienda.local:8081    # rerank
MODELS_API_KEY=<chiave dei llama-server>
```

**Modelli sul server stesso.** Copia i file GGUF di `EMBED_MODEL_ID` e `RERANK_MODEL_ID` in `data/models/` e imposta `LOCAL_MODELS_ENABLED=true` e `LOCAL_LLAMA_BIN` (percorso di `llama-server`).

Poi riavvia il servizio (`systemctl --user restart hivevault` per i servizi utente):

```bash
sudo systemctl restart hivevault
```

Controlla gli endpoint nella console: **Console → Modelli → Prova**. Per l'embedding il modello deve essere lo stesso dei vettori già salvati (`EMBED_MODEL_ID`). Il dispatcher non usa un endpoint con un modello diverso.

## 7. HTTPS

Fuori da `localhost` usa sempre HTTPS. Le passkey e i cookie sicuri non funzionano senza HTTPS.

- Con un certificato aziendale: passa `--tls-cert` e `--tls-key` allo script, oppure imposta `TLS_CERT_FILE` e `TLS_KEY_FILE` in `.env`.
- Senza una CA aziendale: `bash scripts/dev-ca.sh brain.azienda.local` crea una CA e un certificato. Installa `data/tls/ca.pem` come radice attendibile sui computer degli utenti.
- Dietro un reverse proxy: imposta `TRUST_PROXY=true`. Il proxy deve passare `X-Forwarded-For`.

## 8. Controllo finale

1. Apri `https://brain.azienda.local` e accedi come amministratore.
2. Apri **Dashboard → Panoramica**: i pannelli mostrano dati dopo 2 minuti.
3. Esegui una prova di ripristino completa:

   ```bash
   npm run backup -- verify
   ```

   Il comando ripristina l'ultimo backup in un contenitore temporaneo e controlla i dati. Deve finire con «Ripristino verificato».
4. Controlla la catena dell'audit: `npm run cb -- audit verify`.
5. Completa la [checklist di rilascio](../RILASCIO.md) e la [lista §4.1](../sicurezza/privacy.md#41-chi-installa-e-gestisce-il-server).

## 9. Consegna all'azienda e all'amministratore

L'installatore consegna all'azienda:

- l'indirizzo del server e l'account del primo amministratore;
- il luogo dove sono conservate le due chiavi (§5) e l'elenco delle persone che le leggono;
- l'elenco delle persone con accesso al sistema operativo e al database (amministratori di sistema);
- gli host dei modelli configurati e il valore di `EGRESS_ALLOW`;
- la pianificazione dei backup e l'esito della prova di ripristino.

Il primo amministratore, prima di creare gli utenti:

1. **Console → Impostazioni → Privacy**: imposta i giorni di conservazione delle letture e l'acquisizione delle email secondo le decisioni dell'azienda ([guida, §9](amministratore.md#9-impostazioni)).
2. **Console → Impostazioni**: adatta l'avviso sull'agente cloud all'informativa dell'azienda e la finestra del ciclo notturno.
3. **Console → Team**: crea i team ([guida, §2](amministratore.md#2-utenti)).
4. **Console → Utenti**: crea gli utenti, mettili in almeno un team e invia i link di attivazione.
5. **Console → Vault**: crea le celle personali (nascono «personale») e gli spazi condivisi ([guida, §4](amministratore.md#4-vault-e-spazi)).
6. **Console → Permessi**: dai i permessi, ai team quando possibile ([guida, §5](amministratore.md#5-permessi)).
7. **Console → Account API**: crea gli account dell'agente cloud solo dopo l'accordo con il suo fornitore ([guida, §3](amministratore.md#3-account-api-e-agente-cloud)).

## 10. Problemi frequenti

| Problema | Causa | Soluzione |
|---|---|---|
| «l'utente non può usare Docker» | L'utente non è nel gruppo `docker` | `sudo usermod -aG docker brain`, poi esci e rientra |
| Il servizio non parte dopo un riavvio del server | Servizio utente senza linger | `sudo loginctl enable-linger brain` |
| I pannelli delle dashboard restano vuoti | Il server non è avviato da almeno un minuto | Attendi 2 minuti; controlla `journalctl -u hivevault` |
| I documenti restano «in attesa» | Nessun endpoint di embedding attivo | Configura i modelli (§6) e controlla **Console → Modelli** |
| «Modello diverso» nella pagina Modelli | L'endpoint usa un altro modello di embedding | Usa lo stesso file GGUF su tutti gli host |
| Le passkey non funzionano | Il sito è in HTTP o il nome non corrisponde a `PUBLIC_URL` | Usa HTTPS e lo stesso nome di `PUBLIC_URL` |
| Client Node o agente cloud: errori di codifica HTTP verso il server | Un antivirus intercetta l'HTTP locale (per esempio Avast Web Shield) | Aggiungi un'eccezione per l'indirizzo del server |
