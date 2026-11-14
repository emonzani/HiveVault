# Guida dell'utente

HiveVault è la memoria dell'azienda. Raccoglie i documenti e li trasforma in pagine collegate: clienti, persone, progetti, decisioni.

## 1. Primo accesso

1. Apri il link di attivazione che hai ricevuto.
2. Leggi il codice QR con un'app di autenticazione (per esempio Google Authenticator, Microsoft Authenticator, Aegis).
3. Scrivi il codice di 6 cifre dell'app.
4. **Salva i codici di recupero** in un posto sicuro. Ogni codice vale una volta. Ti servono se perdi il telefono.
5. Leggi l'avviso sull'agente cloud e conferma.

Accessi successivi: nome utente e codice dell'app. Per accedere senza codice, aggiungi una passkey in **Il mio account**.

Se perdi il telefono e i codici di recupero, chiedi a un amministratore di azzerare l'autenticazione.

## 2. L'agente cloud e i tuoi dati

- I documenti originali non escono mai dal server dell'azienda.
- L'agente cloud (un servizio esterno) può leggere il testo delle pagine **pubblico** e **interno**.
- L'agente cloud non legge mai le pagine **riservato**, **segreto** e **personale**.
- Nella tua cella puoi usare il livello **personale**: solo tu leggi quei contenuti, nemmeno gli amministratori. Se il tuo account viene cancellato, i contenuti personali vengono cancellati; il resto della cella passa a un tuo team.
- La tua cella nasce con il livello **personale**: quello che scrivi o carichi senza scegliere un livello lo leggi solo tu. Per condividere una pagina o un documento con i colleghi o con l'agente cloud, scegli un livello più basso.
- Le pagine leggibili dall'agente cloud mostrano «☁ Consultabile dall'agente cloud».
- **Cosa ha letto l'agente cloud** (icona a forma di stella) mostra le letture delle pagine della tua cella.
- **Diario di lavoro**: con i prompt `buongiorno`, `chiudi-sessione` e `fine-giornata`, l'agente cloud legge e scrive le note di diario (Fatto, Deciso, Aperto) nella cartella inbox della tua cella. Ogni nota ha un collegamento ad almeno una pagina vera.

Quando carichi un documento con informazioni sensibili, alza la classificazione **prima** di caricarlo.

## 3. Lo schermo

| Zona | Contenuto |
|---|---|
| Barra a sinistra | Cerca, apri una pagina, grafo, inbox, nuova pagina, carica documenti |
| Barra laterale | Il vault attivo, le cartelle, le pagine recenti, la coda dei curatori |
| Centro | Le pagine, in schede. Puoi dividere lo schermo in due pannelli |
| Pannello destro | Struttura della pagina, collegamenti in entrata, menzioni, grafo locale |

## 4. Tasti rapidi

| Tasti | Azione |
|---|---|
| Ctrl O | Apri una pagina per titolo |
| Ctrl Maiusc F | Cerca |
| Ctrl K | Palette dei comandi |
| Ctrl E | Modifica la pagina |
| Alt N | Nuova pagina |
| Alt T / Alt W | Nuova scheda / chiudi la scheda |
| Alt ← / Alt → | Indietro / avanti nella scheda |
| Ctrl \ | Dividi o unisci i pannelli |
| Ctrl B | Mostra o nascondi la barra laterale |

## 5. Cercare

Scrivi una domanda o delle parole chiave. La ricerca trova sia le parole uguali sia il significato. Usa i filtri per vault, tipo di pagina, genere e livello. Passa sopra un risultato per vedere l'anteprima.

## 6. Leggere una pagina

- Le parole sottolineate sono **collegamenti** ad altre pagine. Passa sopra per l'anteprima.
- I numeri tra parentesi sono **citazioni**: aprono il punto del documento da cui viene l'informazione.
- Un riquadro **conflitto** indica due fonti che dicono cose diverse. Un curatore deciderà.
- **Storico** mostra le versioni e le differenze. **Ripristina questa versione** riporta una versione precedente; lo storico resta.

## 7. Scrivere

1. **Nuova pagina** (Alt N): scrivi il titolo e il tipo.
2. Scrivi in Markdown. Scrivi `[[` per collegare un'altra pagina: l'editor propone i titoli. Nella riga `tags:` l'editor propone i tag del vault, i più usati per primi: usa un tag che esiste già invece di scriverne uno simile.
3. Salva con Ctrl S.

Se un'altra persona salva la stessa pagina mentre scrivi, l'editor te lo dice. Copia il tuo testo e ricarica la pagina.

Le pagine dell'alveare (segno «Alveare · N celle») le scrive il ciclo notturno: per cambiarle, modifica la pagina della tua cella o chiedi a un curatore.

## 8. Caricare documenti

1. Seleziona **Carica documenti**, oppure trascina i file nella finestra.
2. Scegli il vault e la classificazione.
3. Seleziona **Carica N file**.

Lo stato di ogni documento cambia sotto i tuoi occhi: in coda, letto, cercabile, compilato. Formati: PDF, Word, Excel, PowerPoint, CSV, email (EML, MSG, MBOX), HTML, ZIP, testo, codice, immagini.

Le email e i loro allegati diventano almeno **riservato**. L'amministratore può disattivare il caricamento delle email: allora il file resta «non supportato». Non caricare la posta di altre persone senza autorizzazione.

Le foto e i PDF scansionati passano dall'OCR, se l'amministratore ha configurato un modello OCR. Senza OCR il documento mostra «Serve l'OCR»: lo trovi per nome, ma non per il testo.

## 9. Coda dei curatori

Se sei curatore di uno spazio, la **Coda dei curatori** mostra:

- **Conflitti**: due celle dicono valori diversi. Scegli il valore giusto o scrivine uno nuovo.
- **Duplicati**: due pagine parlano della stessa cosa. Scegli la pagina da tenere.
- **Proposte dell'agente cloud**: l'agente cloud propone una modifica. Guarda le differenze, poi **Approva e applica** o **Rifiuta**.
- **Modifiche di massa**: il ciclo notturno vuole togliere molte pagine dell'alveare tutte insieme (più di un quinto). Succede se una cella è stata scollegata o svuotata per errore. **Conferma la rimozione** se è giusto, altrimenti **Tieni le pagine**.

## 10. Il mio account

**Il mio account** mostra le tue sessioni, le passkey e le chiavi di firma. Chiudi le sessioni che non riconosci.
