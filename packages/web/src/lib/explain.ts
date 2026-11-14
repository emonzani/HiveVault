// Explanations in plain words (as for a five-year-old) of the console sections and of the
// dashboards. Shown by components/Explain.svelte; the viewer may close them.
import { t } from "./i18n.ts";

export const EXPLAIN_ADMIN: Record<string, string> = {
  utenti:
    t("Gli utenti sono le persone che possono entrare. Ognuna ha un codice segreto sul telefono, che cambia ogni 30 secondi. Tu decidi chi entra, cosa può fare e quanto sono segreti i fogli che può leggere. Per cambiare qualcosa, premi «Modifica» accanto al nome."),
  team:
    t("Un team è un gruppo di persone, per esempio un ufficio. Se dai un permesso al team, lo hanno tutti i suoi membri. Una persona può stare in più team. Quando una persona lascia l'azienda, i suoi fogli di lavoro passano al suo team; i suoi fogli personali vengono cancellati."),
  api:
    t("Gli account API sono per i programmi, non per le persone: per esempio l'agente cloud. Ogni programma ha una chiave, come la chiave di casa. La vedi una volta sola: copiala subito. Se la perdi, ne fai una nuova e butti via la vecchia."),
  vault:
    t("Un vault è una scatola dove si mettono i fogli. Una cella è la scatola di una persona o di un gruppo. Uno spazio dell'alveare è una scatola grande che tutti condividono: ogni notte prende le cose importanti dalle scatole piccole collegate. Premi «Modifica» per cambiare una scatola. Un punto di ripristino è una foto della scatola: se qualcosa va storto, la riporti com'era."),
  permessi:
    t("Qui decidi chi può aprire quale scatola. Scegli una persona (o una scatola) a sinistra: a destra vedi le sue scatole (o le sue persone). «Lettura» vuol dire guardare. «Scrittura» vuol dire anche aggiungere e cambiare. «Curatore» vuol dire anche decidere chi ha ragione quando due fogli dicono cose diverse. Ogni modifica si salva subito."),
  sorgenti:
    t("Le sorgenti sono i documenti veri che sono stati caricati: PDF, email, fogli di calcolo. Il server li legge in quattro passi: li mette al sicuro (I0), legge le parole (I1), capisce il significato (I2), scrive una pagina di riassunto (I3). Con «Modifica» cambi il titolo e quanto è segreto un documento."),
  import:
    t("Un import prende tanti documenti tutti insieme da una cartella del server, come svuotare uno scatolone. Puoi dirgli di andare piano o di lavorare solo di notte, così il server non si stanca quando le persone lavorano."),
  task:
    t("I task sono i lavori lunghi che il server fa da solo, uno dopo l'altro, come una lista di compiti. Se il server si spegne, ricomincia dal punto dove era. Un compito con priorità 0 passa davanti a tutti gli altri."),
  modelli:
    t("I modelli sono i cervelli che leggono e capiscono i testi. Stanno su computer dell'azienda: i documenti non escono mai. Qui vedi se rispondono e quanto sono veloci. Se un cervello cambia indirizzo, premi «Modifica»."),
  audit:
    t("L'audit è il diario del server: scrive chi ha fatto cosa e quando. Nessuno lo può cancellare o cambiare, nemmeno tu: per questo ci si può fidare di quello che dice."),
  impostazioni:
    t("Qui decidi le regole di tutto il server. Il ciclo notturno è come mettere in ordine la cameretta mentre tutti dormono: tu scegli a che ora comincia, a che ora finisce e quanto tempo può usare."),
  backup:
    t("Un backup è una copia di sicurezza, come una foto di tutto. Se qualcosa si rompe, si torna alla foto. Il server ne fa una ogni notte e una volta al mese prova davvero a usarla, per essere sicuro che funzioni."),
};

export const EXPLAIN_DASHBOARD: Record<string, string> = {
  panoramica:
    t("Questa pagina è come il cruscotto di un'auto: con un'occhiata vedi se va tutto bene. Se un riquadro dice «Da controllare» o «Critico», qualcosa va guardato: premi «Apri»."),
  ingestion:
    t("Qui vedi quanti documenti il server sta leggendo e quanti aspettano in fila. Se la fila cresce sempre e non scende mai, il server ha bisogno di più aiuto."),
  ricerca:
    t("Qui vedi quanto tempo ci mette il server a trovare le cose. Più la linea è bassa, più è veloce. Una ricerca già fatta è velocissima, perché il server se la ricorda."),
  salute:
    t("Qui vedi se la memoria è in ordine: collegamenti che non portano da nessuna parte, fogli che nessuno usa, cose che si contraddicono. È come controllare che i libri siano al posto giusto."),
  alveare:
    t("Qui vedi quante informazioni passano dalle celle allo spazio comune, e quante volte due celle dicono cose diverse. Quando succede, un curatore decide chi ha ragione."),
  notte:
    t("Qui vedi il lavoro fatto di notte: quanto tempo ha preso ogni passo e quante parole ha usato il modello per farlo."),
  modelli:
    t("Qui vedi i cervelli al lavoro: quanto sono veloci, quante richieste aspettano il loro turno e se qualcuno sbaglia."),
  database:
    t("Il database è l'armadio dove sta tutto. Qui vedi quanto è pieno, quanto lavora e quali domande gli costano più fatica. Backup e pulizie sono in fondo: sono lenti, ma succedono di rado e va bene così."),
  sicurezza:
    t("Qui vedi chi entra, chi non riesce a entrare e se qualcosa ha provato a mandare dati fuori dalla rete. Se vedi tanti tentativi falliti, forse qualcuno sta provando a indovinare i codici."),
  host: t("L'host è il computer dove gira tutto. La CPU è il cervello che fa i conti; la GPU è un aiutante velocissimo che fa girare il modello di chat. Qui vedi quanto lavorano, quanto sono caldi, quanta memoria usano e quanto spazio resta sul disco."),
};
