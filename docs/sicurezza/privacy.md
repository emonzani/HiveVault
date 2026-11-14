# Protezione dei dati personali: conformità e adempimenti

Questo documento spiega come HiveVault tratta i dati personali. Dice quali requisiti del GDPR e della normativa italiana il software copre. Dice anche cosa deve fare chi installa il server e cosa deve fare l'azienda che lo usa. Alla fine c'è una lista di controllo per ogni figura.

Il documento non è un parere legale. Il responsabile della protezione dei dati (DPO) o un legale dell'azienda lo deve verificare prima dell'uso in produzione. Il software è fornito «così com'è», senza garanzie e senza responsabilità degli autori: vedi §5 e [DISCLAIMER.md](../../DISCLAIMER.md).

## 1. Norme di riferimento

| Norma | Cosa chiede, per HiveVault |
|---|---|
| Regolamento (UE) 2016/679 (GDPR) | Principi (art. 5), privacy by design e by default (art. 25), diritti degli interessati (art. 15–22), sicurezza (art. 32), registro (art. 30), DPIA (art. 35), violazioni (art. 33–34), responsabili (art. 28), trasferimenti fuori dall'UE (capo V) |
| D.Lgs. 196/2003 (Codice privacy), modificato dal D.Lgs. 101/2018 | Regole nazionali; art. 113 e 114 rinviano allo Statuto dei Lavoratori |
| L. 300/1970 (Statuto dei Lavoratori), art. 4 e art. 8 | Controllo a distanza dei lavoratori: accordo sindacale o autorizzazione dell'Ispettorato, salvo gli strumenti di lavoro; informativa adeguata; divieto di indagini sulle opinioni |
| D.Lgs. 152/1997, art. 1-bis | Informativa sui sistemi decisionali o di monitoraggio automatizzati |
| L. 132/2025 (intelligenza artificiale), art. 11 | Il datore di lavoro informa il lavoratore dell'uso di sistemi di IA |
| Regolamento (UE) 2024/1689 (AI Act) | Alfabetizzazione sull'IA del personale (art. 4); obblighi aggiuntivi se un sistema valuta i lavoratori (allegato III, punto 4). Verificate le date di applicazione in vigore |
| Garante, provvedimento del 27 novembre 2008 (amministratori di sistema) | Nomina individuale, elenco aggiornato, log degli accessi inalterabili e conservati almeno 6 mesi, verifica annuale dell'operato |
| D.Lgs. 138/2024 (recepimento della direttiva NIS2) | Se l'azienda è un soggetto essenziale o importante, HiveVault rientra nella sua gestione del rischio informatico e nella notifica degli incidenti |
| Direttiva (UE) 2024/2853 (responsabilità per danno da prodotti difettosi) | Comprende il software. Non si applica al software libero e open source sviluppato o fornito fuori da un'attività commerciale (art. 2, par. 2). Recepimento entro il 9 dicembre 2026 |
| Regolamento (UE) 2024/2847 (Cyber Resilience Act) | Obblighi per i prodotti con elementi digitali messi a disposizione nel corso di un'attività commerciale; esclude il software libero fuori da un'attività commerciale. Obblighi di segnalazione dall'11 settembre 2026, il resto dall'11 dicembre 2027 |
| Codice civile, art. 1229 | Un patto che esclude la responsabilità per dolo o colpa grave è nullo: l'esclusione della licenza vale nei limiti della legge |
| Garante, linee guida del 1° marzo 2007 e documento di indirizzo del 6 giugno 2024 (posta elettronica e metadati) | Limiti al trattamento della posta dei lavoratori e dei suoi metadati |

## 2. Figure

| Figura | Ruolo GDPR | Chi è |
|---|---|---|
| Azienda che adotta il software | Titolare del trattamento | Decide scopi e mezzi; risponde dei trattamenti |
| Chi installa e gestisce il server | Responsabile del trattamento (art. 28) se è un fornitore esterno; personale del titolare se è interno | Installa, aggiorna, fa i backup, ha accesso al sistema operativo e al database |
| Amministratori di HiveVault | Persone autorizzate dal titolare; amministratori di sistema secondo il Garante | Gestiscono utenti, vault, permessi e console |
| Fornitore dell'agente cloud | Responsabile del trattamento (art. 28) | Riceve, tramite MCP, il testo compilato delle pagine «pubblico» e «interno» |
| Lavoratori e altre persone nominate nei documenti | Interessati | Utenti del sistema e persone citate in documenti, email e pagine |
| Autori del software (licenza MIT) | Nessun ruolo | Non installano, non gestiscono e non accedono alle installazioni; non ricevono dati; il software non comunica con loro (§5) |
| Fornitore che installa o assiste a pagamento | Responsabile del trattamento (art. 28) per l'azienda; fabbricante o distributore ai fini della direttiva 2024/2853 e del Cyber Resilience Act se mette il software sul mercato nel corso di un'attività commerciale | Risponde del proprio servizio verso l'azienda; l'esclusione degli autori non lo copre |

## 3. Come il software tratta i dati

### 3.1 Dove stanno i dati

- I documenti originali restano sul server, cifrati con AES-256-GCM e una chiave per vault (`data/blobs/`). Non escono mai.
- Parser, embedding, reranking, OCR e compilazione usano solo modelli locali.
- Ogni connessione in uscita passa dall'egress guard: solo gli host autorizzati.
- Gli host dei modelli (`LLAMA_SERVER_URL`, `REMOTE_EMBED_URLS`, `REMOTE_RERANK_URLS`, `OCR_URLS`) ricevono il testo dei documenti e sono sempre autorizzati. Il software non ha un host predefinito: chi installa li imposta, e devono essere host dell'azienda.
- L'agente cloud legge tramite MCP solo il testo compilato delle pagine «pubblico» e «interno». Il server MCP non consegna mai un livello più alto, qualunque permesso abbia l'account API (`MCP_MAX_CLASSIFICATION`).

### 3.2 Livelli di classificazione

| Livello | Chi lo legge | Agente cloud |
|---|---|---|
| 0 pubblico | Chi ha accesso al vault | Sì, con un account API autorizzato |
| 1 interno | Chi ha accesso al vault | Sì, con un account API autorizzato |
| 2 riservato | Chi ha accesso al vault e livello almeno «riservato» | Mai |
| 3 segreto | Chi ha accesso al vault e livello «segreto» | Mai |
| 4 personale | Solo il proprietario del vault personale | Mai |

**Personale.** Il livello «personale» vale solo nei vault personali (proprietario `user:<id>`). Solo il proprietario lo legge e lo assegna. Gli amministratori non lo leggono in nessuna funzione dell'applicazione:

- la ricerca, le pagine, l'albero, il grafo e le API non lo mostrano (Row Level Security con `cb_personal()`);
- la console non elenca, non modifica e non cancella i documenti personali;
- export, import e punti di ripristino non li includono, non li sovrascrivono e non li cancellano;
- l'unione di pagine e le statistiche della console li escludono;
- il cambio di proprietario di un vault con contenuti personali non è possibile;
- il ciclo notturno non li promuove nell'alveare e non li collega da altre pagine;
- una pagina compilata da un documento personale resta personale.

**Cosa resta dopo la cancellazione di un utente.** Tutto quello che non è «personale» resta. Il contenuto non personale dei suoi vault passa al team scelto dall'amministratore, che ne diventa proprietario. Un vault che contiene solo contenuti personali viene cancellato.

### 3.3 Privacy by default

- Un vault personale nasce «personale»: senza una scelta esplicita, il suo contenuto lo legge solo il proprietario. Né gli amministratori, né gli altri utenti, né l'agente cloud lo leggono, e non sale nell'alveare. Per condividere una pagina o un documento il proprietario sceglie un livello più basso.
- Chi scrive con un permesso nel vault personale di un'altra persona e lascia il livello predefinito crea contenuto «personale» del proprietario: dopo il salvataggio non lo vede più. I dialoghi lo avvisano.
- Se un vault personale passa a un team (cancellazione dell'account), il suo livello predefinito diventa «riservato».
- Un'email (EML, MSG, MBOX) e i suoi allegati diventano almeno «riservato».
- L'amministratore può disattivare l'acquisizione delle email (console, Impostazioni › Privacy, o `INGEST_EMAIL=false`). Un file di posta diventa allora «non supportato».
- Al primo accesso ogni utente legge e conferma l'avviso sull'agente cloud. La conferma è registrata.
- Le pagine del ciclo notturno e dell'alveare mostrano l'avviso «Pagina scritta dal ciclo notturno». Le pagine compilate da un modello citano le fonti e mostrano la fiducia della compilazione, ma non hanno un'etichetta esplicita «scritta da un modello»: spiegatelo agli utenti nella formazione (art. 4 AI Act).
- Ogni pagina mostra se l'agente cloud la può leggere. Il pannello «Cosa ha letto l'agente cloud» elenca le letture delle pagine dell'utente.

### 3.4 Diritti degli interessati

| Diritto | Come si esercita |
|---|---|
| Accesso (art. 15) e portabilità (art. 20) | L'utente legge e scarica in Markdown le sue pagine. Non c'è un export automatico di tutti i dati di una persona: l'amministratore raccoglie i dati con la ricerca, l'export dei vault e il registro di audit. Gli amministratori non possono esportare i contenuti «personale»: li scarica l'interessato. |
| Rettifica (art. 16) | Una pagina normale si modifica subito. Una pagina scritta dal ciclo notturno (alveare, `_inbox/`) la rettifica subito un amministratore. Il server apre una voce «Rettifica» nella coda dei curatori con le pagine e i documenti da cui viene il dato. Finché la voce è aperta, il ciclo notturno non riscrive la pagina. Quando le fonti sono corrette, un curatore chiude la voce. |
| Cancellazione (art. 17) | Pagine e documenti si cancellano con le loro versioni, parti e file originali. La cancellazione di un account cancella i contenuti «personale» e passa il resto a un team. La cancellazione di un vault cancella anche i suoi file originali. |
| Limitazione e opposizione (art. 18, 21) | Si alza la classificazione di una pagina o di un documento, o si toglie un permesso. |

**Dati che restano dopo una cancellazione.**

- Il registro di audit conserva l'identificativo dell'account (non il nome) per il periodo di conservazione degli eventi di sicurezza.
- Le versioni delle pagine non personali conservano l'identificativo dell'autore.
- I backup del database conservano i dati cancellati fino alla loro scadenza (§3.5).
- Le esportazioni dei vault in `data/exports/` restano finché un operatore non le cancella.

### 3.5 Conservazione

| Dato | Periodo | Impostazione |
|---|---|---|
| Eventi di sicurezza dell'audit (accessi, modifiche degli amministratori, credenziali) | 400 giorni; mai meno di 183 (6 mesi) | `AUDIT_RETENTION_DAYS` (minimo 183) |
| Letture dell'audit (`page.read`, `source.read`, `source.download`, `search`, letture MCP) | 30 giorni | Console › Impostazioni › Privacy, oppure `AUDIT_READ_RETENTION_DAYS` |
| Tentativi di accesso falliti (nome utente, IP) | 24 ore | Pulizia notturna |
| Task terminati | 30 giorni | `TASK_RETENTION_DAYS` |
| Sessioni | Fino alla scadenza (12 ore di inattività, 7 giorni al massimo) | `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` |
| Backup del database (pgBackRest) | 2 backup completi settimanali e il WAL tra di essi: un dato cancellato resta nei backup al massimo circa 3 settimane | `repo1-retention-full=2` in `docker/postgres/pgbackrest.conf` |
| File originali in `data/blobs/` | Fino alla cancellazione del documento; nelle copie del filesystem secondo la politica di backup dell'azienda | Strumento di backup dell'azienda |
| Esportazioni dei vault in `data/exports/` | Fino alla cancellazione manuale | Operatore |
| Metriche | Nessun dato personale: le etichette non contengono utenti, pagine o testi | — |

**Ripristino da backup.** Un ripristino riporta anche i dati cancellati dopo il backup. Dopo un ripristino, l'amministratore ripete le cancellazioni registrate nell'audit dopo l'istante ripristinato (`admin.principal.delete`, `source.delete`, `page.delete`, `admin.source.delete`).

### 3.6 Registro di audit e amministratori di sistema

- Il registro è in sola aggiunta. Il database rifiuta `UPDATE` e `TRUNCATE`, e rifiuta la cancellazione di un evento di sicurezza con meno di 6 mesi (trigger della migrazione `014_privacy.sql`).
- Ogni evento di sicurezza contiene l'hash del precedente (catena SHA-256). Una riga cambiata, tolta o aggiunta interrompe la catena.
- La verifica: `npm run cb -- audit verify`, oppure `GET /api/admin/audit/verify`. Anche la verifica viene registrata.
- Ogni notte il server scrive nel log applicativo l'ultimo anello della catena (`audit chain head`). Conservate questo log fuori dal server: serve a scoprire una catena riscritta da chi ha accesso al database.
- Le letture (chi ha letto cosa) stanno fuori dalla catena: hanno una conservazione breve (§3.5).

### 3.7 Controllo a distanza dei lavoratori

Il registro delle letture mostra quali pagine legge ogni persona. Serve alla sicurezza e al calcolo dell'importanza delle pagine (ultimi 30 giorni). Può servire anche a controllare l'attività dei lavoratori: per questo l'art. 4 dello Statuto si applica.

- La conservazione predefinita è 30 giorni. Riducetela al minimo concordato.
- Non usate il registro per valutare le prestazioni o per decisioni sui lavoratori.
- Non usate HiveVault per valutare, selezionare o sorvegliare le persone: diventerebbe un sistema ad alto rischio secondo l'AI Act.

### 3.8 Limiti residui

Il software protegge i dati nell'applicazione e nel database. Alcune persone possono comunque accedere ai dati con mezzi tecnici. Queste misure sono organizzative, non tecniche:

- Chi ha accesso al sistema operativo, al superutente del database o alla chiave principale (`data/.master-key`) può leggere tutti i dati, anche i contenuti «personale», e può disattivare i trigger dell'audit. Riducete queste persone al minimo, nominatele amministratori di sistema e conservate fuori dal server il log con la catena dell'audit.
- Un amministratore può reimpostare le credenziali di un utente e poi entrare come quell'utente. L'operazione è registrata nell'audit e l'utente perde l'accesso: la scopre al primo accesso successivo. Vietatela nella policy interna, salvo richiesta dell'utente.
- I backup contengono anche i contenuti «personale», cifrati con le stesse chiavi.
- Il sistema non riconosce da solo i dati personali in un documento: la classificazione la sceglie chi carica il documento.

## 4. Liste di controllo

### 4.1 Chi installa e gestisce il server

- [ ] Firmare con l'azienda l'accordo sul trattamento (art. 28), se è un fornitore esterno.
- [ ] Installare il server in una rete dell'azienda o in un data center nell'UE.
- [ ] Generare la chiave principale e conservarne una copia offline, accessibile a poche persone nominate.
- [ ] Attivare HTTPS (`TLS_CERT_FILE`, `TLS_KEY_FILE`) o un proxy TLS (`TRUST_PROXY`).
- [ ] Impostare come host dei modelli solo server dell'azienda (§3.1).
- [ ] Limitare `EGRESS_ALLOW` agli host necessari.
- [ ] Attivare i timer di backup e la prova mensile di ripristino (`npm run backup -- verify`).
- [ ] Includere `data/blobs/` nel backup dell'azienda; escludere `data/exports/` o cancellare le esportazioni dopo l'uso.
- [ ] Inviare il log applicativo (con `audit chain head`) a un sistema di log esterno al server.
- [ ] Eseguire `npm run cb -- audit verify` almeno una volta al mese e conservarne l'esito.
- [ ] Impostare `AUDIT_READ_RETENTION_DAYS` e `INGEST_EMAIL` secondo le decisioni dell'azienda.
- [ ] Tenere l'elenco delle persone con accesso al sistema operativo, al database e alla chiave principale.
- [ ] Aggiornare il server con `scripts/deploy.sh` e annotare ogni aggiornamento.
- [ ] Avvisare subito l'azienda di ogni violazione sospetta (art. 33, comma 2).

### 4.2 Azienda che adotta il software (titolare)

- [ ] Inserire il trattamento nel registro delle attività (art. 30): scopi, categorie di dati e di interessati, destinatari, trasferimenti, periodi di conservazione (§3.5), misure di sicurezza.
- [ ] Fare la valutazione d'impatto (DPIA, art. 35) prima dell'uso: trattamento sistematico di dati dei lavoratori con una tecnologia nuova.
- [ ] Firmare l'accordo art. 28 con il fornitore dell'agente cloud e verificare la base del trasferimento fuori dall'UE (decisione di adeguatezza EU-US Data Privacy Framework con il fornitore certificato, oppure clausole contrattuali standard).
- [ ] Decidere quali vault l'agente cloud può leggere e dare agli account API il livello minimo («interno» al massimo).
- [ ] Fare l'accordo sindacale o chiedere l'autorizzazione dell'Ispettorato del Lavoro (art. 4 dello Statuto), se il registro delle letture o l'uso del sistema permettono un controllo a distanza.
- [ ] Dare ai lavoratori l'informativa (art. 13 GDPR, art. 4 comma 3 dello Statuto, art. 1-bis D.Lgs. 152/1997, art. 11 L. 132/2025): cosa registra il sistema, per quanto tempo, chi lo legge, l'uso dell'IA e dell'agente cloud.
- [ ] Scrivere la policy sulle email: quali caselle si caricano, di chi, con quale base giuridica; disattivare l'acquisizione se non serve.
- [ ] Scrivere la policy sulla classificazione: quando usare «riservato», «segreto» e «personale».
- [ ] Nominare per iscritto gli amministratori di sistema e tenere il loro elenco (provvedimento del 2008).
- [ ] Verificare ogni anno l'operato degli amministratori con il registro di audit.
- [ ] Scrivere la procedura per i diritti degli interessati (§3.4) e per le cancellazioni dopo un ripristino da backup (§3.5).
- [ ] Scrivere la procedura per le violazioni (art. 33–34): notifica al Garante entro 72 ore.
- [ ] Formare gli utenti sull'IA e sulla classificazione (art. 4 AI Act).
- [ ] Non usare il sistema per valutare o sorvegliare i lavoratori.

### 4.3 Amministratori di HiveVault

- [ ] Creare un vault personale per ogni utente che ne ha bisogno: nasce «personale».
- [ ] Mettere ogni utente in almeno un team, così la sua cancellazione ha un erede.
- [ ] Dare i permessi ai team, non alle singole persone, quando possibile.
- [ ] Non reimpostare le credenziali di un utente per entrare al suo posto.
- [ ] Prima di cancellare un account, scegliere il team che riceve i contenuti non personali.
- [ ] Rettificare le pagine dell'alveare su richiesta e seguire le voci «Rettifica» nella coda dei curatori fino alla correzione delle fonti.
- [ ] Controllare la catena dell'audit (console o CLI) e segnalare ogni interruzione al titolare.

### 4.4 DPO (se nominato)

- [ ] Verificare questo documento e la DPIA.
- [ ] Verificare le basi giuridiche, l'informativa e l'accordo con le rappresentanze sindacali.
- [ ] Verificare gli accordi art. 28 e la base dei trasferimenti.
- [ ] Partecipare alla verifica annuale degli amministratori di sistema.

### 4.5 Utenti

- [ ] Leggere e confermare l'avviso sull'agente cloud.
- [ ] Classificare i documenti al caricamento: «personale» per i propri dati privati, «riservato» o «segreto» per i dati di altre persone.
- [ ] Non caricare caselle di posta o documenti di altre persone senza autorizzazione.
- [ ] Controllare nel pannello «Cosa ha letto l'agente cloud» le letture delle proprie pagine.

## 5. Licenza ed esclusione di responsabilità

- HiveVault ha licenza MIT ([LICENSE](../../LICENSE)). Il software è fornito «così com'è» (as is), senza garanzie espresse o implicite.
- Nella misura massima consentita dalla legge, gli autori non rispondono di danni, perdite di dati, violazioni di dati personali, sanzioni o pretese di terzi collegati al software o al suo uso.
- Gli autori non hanno alcun ruolo nei trattamenti: non sono titolari né responsabili. Ogni obbligo di questo documento è dell'azienda che adotta il software e di chi lo installa e lo gestisce.
- Il software è distribuito come software libero, fuori da un'attività commerciale degli autori. Chi lo fornisce, lo installa o lo assiste a pagamento risponde del proprio servizio.
- L'esclusione non vale dove la legge la vieta (per esempio dolo e colpa grave, art. 1229 del Codice civile).

Il testo completo, in italiano e in inglese, è in [DISCLAIMER.md](../../DISCLAIMER.md).
