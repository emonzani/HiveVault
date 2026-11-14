# Guida dell'amministratore

Questa guida è per gli amministratori di HiveVault. Apri la console con l'icona **Console di amministrazione** nella barra a sinistra. Solo gli account con il ruolo «Amministratore» vedono la console e le dashboard.

Ogni modifica che fai nella console va subito nel log di audit.

## 1. Concetti

| Concetto | Significato |
|---|---|
| Cella | Il vault di una persona, di un gruppo o di un progetto |
| Spazio dell'alveare | Un vault condiviso. Le celle collegate lo alimentano ogni notte |
| Permesso | Lettura, Scrittura, Curatore o Amministra, per account e per vault |
| Livello (clearance) | La classificazione più alta che l'account può leggere: pubblico, interno, riservato, segreto |
| Classificazione | Il livello di un vault, di un documento o di una pagina: pubblico, interno, riservato, segreto, personale |
| Team | Un gruppo di utenti. I permessi del team valgono per tutti i membri |

Un account legge una pagina solo se ha un permesso sul vault **e** il suo livello è uguale o più alto della classificazione della pagina. L'agente cloud legge al massimo il livello «interno», qualunque sia il livello dell'account.

Il livello **personale** è fuori da questa scala. Vale solo nella cella di una persona e solo quella persona lo legge. Gli amministratori non vedono i contenuti personali in nessuna sezione della console. Le regole complete sono in [Protezione dei dati personali](../sicurezza/privacy.md).

In ogni sezione della console e in ogni dashboard il riquadro **Spiegato in parole semplici** dice in poche righe a cosa serve la pagina. Chiudilo quando non ti serve più: resta chiuso.

## 2. Utenti

**Console → Utenti → Nuovo utente**

1. Scrivi il nome account (minuscole, cifre, punto, trattino), il nome visibile, il ruolo e il livello.
2. Seleziona **Crea**. La console mostra un link di attivazione.
3. Invia il link alla persona. La persona apre il link, configura l'app di autenticazione e salva i codici di recupero.

Il link scade. Se scade, seleziona l'utente e poi **Azzera l'autenticazione**: la console mostra un nuovo link.

| Azione | Dove | Effetto |
|---|---|---|
| Cambiare ruolo o livello | Dettaglio dell'utente → **Salva** | Vale dalla richiesta successiva |
| Sospendere | **Sospendi** | Sessioni e chiavi smettono di funzionare finché non riattivi |
| Telefono perso | **Azzera l'autenticazione** | Chiude le sessioni e crea un nuovo link di attivazione |
| Sessione rubata | **Chiudi tutte le sessioni**, o una sola sessione | La persona deve accedere di nuovo |
| Passkey o chiave di firma persa | **Rimuovi** o **Revoca** | La credenziale non funziona più |
| Eliminare | **Elimina**, scegli il team, poi **Elimina definitivamente** e conferma con il nome account | Irreversibile. I contenuti «personale» della persona vengono cancellati. Il resto delle sue celle passa al team scelto; una cella vuota viene cancellata |

Non puoi eliminare o sospendere il tuo account. La console impedisce di togliere l'ultimo amministratore.

Se la persona è in un solo team, il team è già scelto. Se è in più team o in nessuno, scegli tu il team. I dati cancellati restano nei backup del database per circa 3 settimane.

**Console → Team** crea i team e gestisce i membri. Un utente può stare in più team. Per dare un permesso a un team, apri **Modifica i permessi** dal team. Un team non accede al server e non ha chiavi. Un team che possiede celle non si elimina: assegna prima le celle a un altro proprietario.

## 3. Account API e agente cloud

**Console → Account API → Nuovo account API**

1. Scrivi il nome, scegli i permessi della chiave (lettura, scrittura, caricamento, amministrazione) e il livello.
2. Facoltativo: data di scadenza, indirizzi ammessi, richieste al minuto.
3. Seleziona **Crea**. La console mostra la chiave **una volta sola**. Copiala subito.

Per l'agente cloud bastano il permesso di lettura e il livello «interno». Poi dai all'account il permesso di lettura sugli spazi che l'agente cloud può consultare (§5).

**Agenti di programmazione:** ogni installazione di un agente di programmazione usa una chiave propria, legata alla persona che la usa. Crea l'account con i permessi «lettura» e «documentazione dei progetti» (`read`, `projects`) e scegli la persona in **Agisce per l'utente**. La chiave:

- legge, tramite MCP, i vault che la persona può leggere (anche con i permessi dei suoi team), mai sopra «interno» e mai i vault personali della persona;
- scrive solo nei vault di progetto (proprietario `project:<slug>`) su cui la persona ha la scrittura: le sei sezioni (specifiche, analisi funzionale, analisi tecnica, analisi architetturale, indice del codice, documenti, in `progetto/`) e le note nella inbox, che l'ingestion compila in pagine;
- non scrive niente con le altre funzioni dell'API;
- quando crea il vault di un progetto nuovo, dà alla persona il permesso di scrittura su quel vault;
- non funziona più se la persona è sospesa o cancellata.

Per riusare analisi e concetti degli altri progetti, dai ai team il permesso di lettura sui vault di progetto (§5). Se una persona cambia una sezione, l'agente la deve leggere di nuovo prima di riscriverla. Per creare l'account dal server senza mostrare la chiave:

```bash
npm run -s cb -- api create agente-nome.cognome --scopes read,projects --user nome.cognome > chiave.txt
```

Un account con il solo permesso `projects` (senza `read`) scrive solo le sei sezioni e non usa MCP.

**Rotazione di una chiave:** seleziona l'account → **Nuova chiave (rotazione)**. Aggiorna il client con la nuova chiave. Poi revoca la chiave vecchia.

## 4. Vault e spazi

**Console → Vault e spazi → Nuovo vault**

- **Tipo**: cella o spazio dell'alveare.
- **Identificativo**: nome breve per gli indirizzi (minuscole, cifre, trattini). Non si cambia dopo la creazione.
- **Tipo di proprietario** (solo per una cella): utente, progetto, team o edge. Dopo il tipo, scrivi almeno 2 caratteri del nome e scegli tra i suggerimenti. Un utente o un team si sceglie sempre dai suggerimenti; per gli altri tipi puoi scrivere anche un nome nuovo. Il proprietario utente amministra la cella senza altri permessi; i membri di un team proprietario la scrivono.
- **Classificazione predefinita**: il livello dei documenti nuovi. Vuoto = valore di **Impostazioni**; per la cella di un utente, «personale». «Personale» si sceglie solo per la cella di un utente.
- Una cella con contenuti personali non cambia proprietario.
- **Indice vettoriale**: «binario + rerank» è il valore consigliato.

Per uno spazio, la sezione **Celle che alimentano lo spazio** sceglie le celle. Senza tipi, la cella condivide tutte le pagine; con i tipi, solo quelle. Le pagine private non arrivano mai nell'alveare. La promozione avviene nel ciclo notturno; **Ciclo notturno ora** la avvia subito.

Nella scheda del vault puoi cambiare anche il **proprietario** (chi vede la cella come propria) e **SCHEMA.md**, le regole che il modello segue quando compila le pagine del vault. L'identificativo non si cambia: è negli indirizzi `brain://` e nei collegamenti.

**Esporta zip** scarica le pagine in Markdown. **Importa zip** le ripristina. Prima dell'import il server salva un punto di ripristino. Se l'import riscrive più di un quinto delle pagine del vault, la console chiede una seconda conferma.

**Punti di ripristino**: una copia delle pagine del vault in un momento.

- **Salva un punto** crea una copia con un nome, per esempio prima di una riorganizzazione.
- **Ripristina** riporta tutte le pagine a quella copia: le pagine cambiate tornano come allora (con una nuova versione), le pagine nuove vanno via, le pagine cancellate tornano con il loro id. Prima del ripristino il server salva lo stato attuale in un punto automatico: puoi annullare il ripristino.
- Il server tiene gli ultimi 5 punti automatici di ogni vault. I punti manuali restano finché non li elimini.
- Le pagine dell'alveare non sono nei punti di ripristino: il ciclo notturno le ricostruisce.

**Elimina il vault** cancella pagine, documenti e vettori. Scrivi l'identificativo per confermare. L'operazione è irreversibile.

## 5. Permessi

**Console → Permessi** mostra un account o un vault alla volta.

1. Scegli **Per account** o **Per vault**.
2. Cerca nella lista a sinistra e scegli una riga.
3. A destra vedi i permessi. Cambia il permesso nel menu o premi **Togli**.
4. Per un permesso nuovo, cerca l'altra parte in **Aggiungi un permesso** (almeno 2 caratteri), scegli il permesso e premi **Aggiungi**.

Ogni modifica vale subito e va nell'audit. Le celle di cui un utente è proprietario hanno l'etichetta **Proprietario**. Un amministratore vede tutti i vault. Dalla scheda di un utente, **Modifica i permessi** apre questa pagina sull'utente.

| Permesso | Cosa permette |
|---|---|
| Lettura | Cercare e leggere |
| Scrittura | Anche creare, modificare, caricare documenti |
| Curatore | Anche decidere i conflitti dell'alveare e le proposte dell'agente cloud |
| Amministra | Anche gestire il vault |

Gli amministratori vedono tutti i vault. Ogni persona vede sempre la propria cella.

## 6. Sorgenti e import

**Console → Sorgenti** mostra i documenti di tutti i vault con stato e livello:

| Livello | Significato |
|---|---|
| I0 | Conservato (originale cifrato) |
| I1 | Testo cercabile |
| I2 | Vettori pronti (ricerca semantica) |
| I3 | Pagina compilata dal modello |

**Riprova** legge di nuovo il documento. **Compila** crea subito la pagina. **Elimina** cancella il documento, i file che contiene (zip, allegati) e l'originale cifrato. Le pagine compilate restano.

**Modifica** cambia il titolo e la classificazione di un documento:

- La classificazione vale anche per i file contenuti e per il testo cercabile: la ricerca e l'agente cloud vedono subito il nuovo livello.
- Se **alzi** la classificazione, la pagina compilata dal documento sale allo stesso livello (nuova versione della pagina).
- Se la **abbassi**, la console chiede conferma: più persone trovano il documento e, con «pubblico» o «interno», anche l'agente cloud può leggerne il testo. La pagina compilata non scende: abbassala dalla pagina stessa, se serve.

**Console → Import massivi** carica una cartella del server (per esempio una condivisione di rete montata). La cartella deve essere sotto `IMPORT_ROOTS`. Puoi limitare i file al secondo e la fascia oraria. **Nuova scansione** legge solo i file nuovi o cambiati.

**Modifica** cambia le impostazioni di un import, anche in corso: velocità, fascia oraria, classificazione e compilazione valgono subito; i filtri (includi, escludi) dalla scansione successiva. La classificazione vale per i file caricati da quel momento. La cartella e il vault non cambiano: per un'altra cartella crea un nuovo import.

## 7. Task

**Console → Task** mostra il lavoro lungo del server. Un task fallito mostra l'errore; **Riprova** lo mette di nuovo in coda. **Annulla** ferma un task in corso; gli effetti già registrati restano.

Per un task in coda o in attesa, il dettaglio permette di cambiare la **priorità** (0 parte per primo, 9 per ultimo) e di avviarlo subito con **Esegui ora**.

Una compilazione che aspetta il modello di chat (un solo posto libero) resta «In attesa» e lascia il worker agli altri documenti: è normale, riparte da sola. Lo stesso vale per la fase OCR quando il modello OCR non risponde.

## 8. Modelli

**Console → Modelli** mostra ogni endpoint: stato, latenza, elementi al secondo, errori.

- **Prova** controlla l'endpoint con una richiesta minima.
- **OCR (immagini)**: un modello che legge le immagini. Il server lo usa per le foto e per le pagine dei PDF scansionati (pagine senza testo). Va bene un `llama-server` con un modello visione (`--mmproj`), oppure Baidu Unlimited-OCR su SGLang (`OCR_PROMPT=unlimited-ocr`; richiede una GPU NVIDIA). Il server legge `OCR_PAGES_PER_REQUEST` pagine insieme, così una tabella su due pagine resta intera. Quando aggiungi il primo endpoint OCR, il ciclo notturno legge di nuovo i documenti che aspettavano l'OCR.
- **Processi locali**: avvia, ferma, riavvia; thread e fascia oraria si applicano senza riavvio del server.
- **Aggiungi un endpoint remoto**: l'indirizzo deve essere nella rete aziendale. La console rifiuta un indirizzo pubblico, perché il testo dei documenti non deve uscire dalla rete.
- **Modifica** cambia l'indirizzo di un endpoint remoto, con la stessa regola; il dispatcher controlla di nuovo il modello. Per gli endpoint del file `.env` la console salva il nuovo indirizzo nelle impostazioni (segno «indirizzo cambiato dalla console») e lo usa anche dopo un riavvio; per tornare all'indirizzo del `.env`, scrivilo di nuovo.

Il **log di audit** non si modifica e non si cancella dalla console: un registro modificabile non vale come prova.

## 9. Impostazioni

| Impostazione | Effetto |
|---|---|
| Ciclo notturno | Finestra, minuti e token per vault, compilazioni per notte, uso del modello di chat |
| Classificazione predefinita | Livello dei nuovi vault |
| Privacy | Giorni di conservazione delle letture (chi ha letto cosa); acquisizione dei file di posta (EML, MSG, MBOX) sì o no |
| Avviso sull'agente cloud | Testo che ogni utente legge e conferma al primo accesso |

## 10. Audit

**Console → Audit** cerca gli eventi per account, azione, esito e periodo. Esempi di azione: `login*` (accessi), `admin.*` (modifiche degli amministratori), `page.read` con `via: mcp` (letture dell'agente cloud), `egress.blocked` (connessioni bloccate).

Il registro è in sola aggiunta: nessuno lo può modificare dall'applicazione o dal database, e gli eventi di sicurezza restano almeno 6 mesi. Per controllare che nessuno lo abbia alterato, esegui `npm run cb -- audit verify` sul server, oppure apri `GET /api/admin/audit/verify`.

### Rettificare una pagina generata

Le pagine dell'alveare e le pagine di `_inbox/` le scrive il ciclo notturno. Un amministratore le corregge subito con **Modifica**. Dopo il salvataggio la coda dei curatori mostra la voce **Rettifica** con le pagine e i documenti da cui viene il dato. Finché la voce è aperta, il ciclo notturno non riscrive la pagina. Correggi le fonti, poi seleziona **Fonti corrette**: dalla notte dopo la pagina si ricostruisce dalle fonti.

## 11. Dashboard

L'icona **Dashboard** apre 10 dashboard. In alto scegli il periodo e l'aggiornamento automatico. **Tabella** mostra i valori di un grafico. **Apri →** porta all'elenco filtrato nella console. L'icona con la matita sposta e ridimensiona i pannelli; il layout resta salvato per te.
