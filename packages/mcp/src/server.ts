/**
 * MCP server of HiveVault (plan §7.1): 11 tools, 4 resource templates, 6 prompts. One server
 * object per HTTP request (stateless streamable HTTP), bound to the calling API account.
 * Tool descriptions are short and precise: fewer definition tokens, more reliable choices.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readPage, withReader } from "@cb/brain";
import { renderIndexes } from "@cb/hive";
import { z } from "zod";
import {
  brainAsk,
  brainCapture,
  brainChanges,
  brainNeighbors,
  brainOverview,
  brainJournal,
  brainProposeEdit,
  brainRead,
  brainSearch,
  brainSource,
  brainTimeline,
  brainVerify,
  readerOf,
  ToolError,
  type ToolContext,
} from "./tools.ts";

export const SERVER_INSTRUCTIONS = [
  "HiveVault è la memoria dell'azienda: pagine compilate (entità, concetti, decisioni) con citazioni ai documenti originali.",
  "Flusso: brain_search per trovare, brain_read con max_tokens per leggere (prima «Stato attuale», poi il resto), brain_neighbors e brain_timeline per relazioni e storia, brain_source per verificare una citazione.",
  "Cita ogni fatto con l'id tra ^[ ] che i tool restituiscono. Se la memoria non contiene l'informazione, dillo: non completare con ipotesi.",
  "Un risultato «non ancora compilato» e un avviso «documenti più recenti della pagina» indicano documenti che le pagine non includono ancora: leggili con brain_read prima di rispondere. La risorsa brain://<vault>/changes?since=<data> dice cosa è cambiato.",
  "Vedi solo le pagine «pubblico» e «interno». I documenti originali restano sul server.",
].join("\n");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
async function run(fn: () => Promise<string>): Promise<Text> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}

export function createMcpServer(ctx: ToolContext, o: { version?: string } = {}): McpServer {
  const server = new McpServer({ name: "hivevault", version: o.version ?? "0.6.0" }, { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } });

  server.registerTool(
    "brain_overview",
    {
      title: "Panoramica della memoria",
      description: "Vault accessibili, pagine per categoria, copertura dei documenti (I1/I2/I3) e pagine aggiornate di recente. Usalo per primo se non conosci i vault.",
      annotations: READ,
    },
    () => run(() => brainOverview(ctx)),
  );

  server.registerTool(
    "brain_search",
    {
      title: "Cerca nella memoria",
      description: "Ricerca ibrida (parole, significato, titoli) con riordino. Restituisce id, titolo, tipo, livello, sintesi, estratti con citazione e il costo in token di ogni risultato.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("Domanda o parole chiave, in italiano o inglese"),
        vaults: z.array(z.string()).max(20).optional().describe("Slug o id dei vault (default: tutti)"),
        types: z.array(z.string()).max(10).optional().describe("Tipi di pagina: entity, entity/company, concept, decision, synthesis, note"),
        limit: z.number().int().min(1).max(20).optional().describe("Risultati (default 8)"),
        max_tokens: z.number().int().min(200).max(8000).optional().describe("Budget della risposta (default 2000)"),
      },
      annotations: READ,
    },
    (a) => run(() => brainSearch(ctx, a)),
  );

  server.registerTool(
    "brain_read",
    {
      title: "Leggi una pagina",
      description: "Legge una pagina (id o titolo) o un documento non compilato (id src_…) entro un budget: sintesi e «Stato attuale» per primi, poi le sezioni pertinenti alla query. Elenca le sezioni escluse con il loro costo.",
      inputSchema: {
        id: z.string().min(1).max(300).describe("Id della pagina (ent_…, cpt_…), titolo o id di documento (src_…)"),
        sections: z.array(z.string()).max(20).optional().describe("Solo queste sezioni (id o titolo, es. timeline)"),
        max_tokens: z.number().int().min(100).max(12000).optional().describe("Budget (default 2000)"),
        query: z.string().max(500).optional().describe("Porta prima le sezioni pertinenti a questo testo"),
      },
      annotations: READ,
    },
    (a) => run(() => brainRead(ctx, a)),
  );

  server.registerTool(
    "brain_neighbors",
    {
      title: "Collegamenti di una pagina",
      description: "Pagine collegate in uscita e in entrata (backlink), menzioni senza link, fino a 2 passi. Per domande relazionali: chi lavora con chi, quali progetti di un cliente.",
      inputSchema: {
        id: z.string().min(1).max(300).describe("Id o titolo della pagina"),
        depth: z.number().int().min(1).max(2).optional().describe("Profondità (default 1)"),
      },
      annotations: READ,
    },
    (a) => run(() => brainNeighbors(ctx, a)),
  );

  server.registerTool(
    "brain_timeline",
    {
      title: "Eventi nel tempo",
      description: "Eventi datati di un'entità (dalla sua Timeline e dalle pagine che la citano), oppure gli eventi dei vault in un periodo.",
      inputSchema: {
        entity: z.string().max(300).optional().describe("Id o titolo dell'entità"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Data iniziale AAAA-MM-GG"),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Data finale AAAA-MM-GG"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ,
    },
    (a) => run(() => brainTimeline(ctx, a)),
  );

  server.registerTool(
    "brain_source",
    {
      title: "Testo di una citazione",
      description: "Risolve una citazione ^[src_…#c3] nel testo estratto di quella parte del documento (con le parti vicine se chiedi context). Il file originale non esce mai dal server.",
      inputSchema: {
        ref: z.string().min(1).max(200).describe("Citazione, es. src_01ABC#c3 oppure ent_01XYZ#stato-attuale"),
        context: z.number().int().min(0).max(3).optional().describe("Parti vicine da includere (default 0)"),
      },
      annotations: READ,
    },
    (a) => run(() => brainSource(ctx, a)),
  );

  if (ctx.dispatcher) {
    server.registerTool(
      "brain_ask",
      {
        title: "Chiedi al modello locale",
        description: "Risposta breve scritta dal modello locale di HiveVault sulle pagine e fonti trovate, con citazioni e conflitti segnalati. Utile per domande puntuali; per analisi lunghe preferisci search + read.",
        inputSchema: {
          question: z.string().min(3).max(500),
          vaults: z.array(z.string()).max(20).optional(),
          max_tokens: z.number().int().min(500).max(6000).optional().describe("Budget del contesto letto (default 3000)"),
        },
        annotations: { ...READ, idempotentHint: false },
      },
      (a) => run(() => brainAsk(ctx, a)),
    );
    server.registerTool(
      "brain_verify",
      {
        title: "Verifica un'affermazione",
        description:
          "Il modello locale controlla un'affermazione sulla memoria: cerca anche le prove contrarie (stesso argomento senza i valori) e risponde supportata, in parte, contraddetta o non verificabile, con le citazioni a favore e contro.",
        inputSchema: {
          claim: z.string().min(5).max(500).describe("L'affermazione da verificare, per esempio «Il contratto con ACME scade il 2027-03-31»"),
          vaults: z.array(z.string()).max(20).optional(),
          max_tokens: z.number().int().min(500).max(8000).optional().describe("Budget del contesto letto (default 4000)"),
        },
        annotations: { ...READ, idempotentHint: false },
      },
      (a) => run(() => brainVerify(ctx, a)),
    );
  }

  server.registerTool(
    "brain_capture",
    {
      title: "Salva una nota",
      description:
        "Salva una nota o una sintesi utile nella inbox di un vault scrivibile, così le buone risposte tornano nella memoria. Con compile true la nota va all'ingestion come documento: HiveVault la compila in pagine (concetti, decisioni) con citazioni; è il predefinito nei vault di progetto. Con compile false resta una nota nella cartella inbox. Richiede l'ambito write o projects.",
      inputSchema: {
        title: z.string().min(3).max(200),
        content: z.string().min(1).max(50_000).describe("Markdown; cita le fonti con ^[id]"),
        vault: z.string().max(100).optional().describe("Slug del vault (default: la cella scrivibile)"),
        tags: z.array(z.string().max(40)).max(10).optional(),
        classification: z.enum(["pubblico", "interno"]).optional(),
        compile: z.boolean().optional().describe("true: documento compilato dall'ingestion; false: nota nella cartella inbox (default: true nei vault di progetto)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(() => brainCapture(ctx, a)),
  );

  server.registerTool(
    "brain_journal",
    {
      title: "Diario di lavoro",
      description:
        "Il diario delle sessioni di lavoro. action «leggi»: le ultime note (dove eravamo rimasti, cosa è aperto). action «sessione» o «giornata»: scrive una nota nella inbox con le sezioni Fatto, Deciso, Aperto, collegata con [[link]] alle pagine vere toccate (almeno una, tutte esistenti). «giornata» elenca anche le sessioni del giorno. Scrivere richiede l'ambito write.",
      inputSchema: {
        action: z.enum(["leggi", "sessione", "giornata"]),
        summary: z.string().max(300).optional().describe("Una frase su cosa è stato fatto"),
        fatto: z.array(z.string().max(500)).max(30).optional(),
        deciso: z.array(z.string().max(500)).max(30).optional().describe("Le scelte prese e il perché"),
        aperto: z.array(z.string().max(500)).max(30).optional().describe("Cosa resta in sospeso"),
        links: z.array(z.string().max(300)).max(30).optional().describe("Titoli delle pagine toccate (clienti, progetti, persone)"),
        vault: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(20).optional().describe("Note da leggere (default 3)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(() => brainJournal(ctx, a)),
  );

  server.registerTool(
    "brain_propose_edit",
    {
      title: "Proponi una modifica",
      description: "Propone una modifica a una pagina (una sezione o la pagina intera) con la motivazione. Non cambia nulla finché una persona non la approva nella coda dei curatori. Richiede l'ambito write.",
      inputSchema: {
        page: z.string().min(1).max(300).describe("Id o titolo della pagina"),
        section: z.string().max(100).optional().describe("Id o titolo della sezione da sostituire"),
        text: z.string().max(50_000).optional().describe("Nuovo testo della sezione"),
        markdown: z.string().max(200_000).optional().describe("In alternativa: il nuovo testo dell'intera pagina"),
        rationale: z.string().min(3).max(1000).describe("Perché, con le fonti ^[id]"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(() => brainProposeEdit(ctx, a)),
  );

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------
  const vaultRows = () => ctx.sql<{ id: string; slug: string; name: string }[]>`select id, slug, name from vaults where id = any(${readerOf(ctx).vaults}) order by kind, name`;
  const vaultBySlug = async (slug: string) => (await vaultRows()).find((v) => v.slug === slug || v.id === slug);
  const indexText = async (slug: string, name: "index" | "llms") => {
    const v = await vaultBySlug(slug);
    if (!v) throw new ToolError(`Vault «${slug}» non accessibile.`);
    // built for this reader (clearance ≤ interno): the stored index of the dream cycle lists
    // every page of the vault, also the reserved ones
    const r = await withReader(ctx.sql, readerOf(ctx, [v.id]), (tx) => renderIndexes(tx, v.id));
    return r?.[name] ?? "Indice non disponibile.";
  };

  server.registerResource(
    "vault-index",
    new ResourceTemplate("brain://{vault}/index", {
      list: async () => ({ resources: (await vaultRows()).map((v) => ({ uri: `brain://${v.slug}/index`, name: `Indice di ${v.name}`, mimeType: "text/markdown" })) }),
    }),
    { title: "Indice del vault", description: "Catalogo delle pagine per categoria, le più importanti per prime", mimeType: "text/markdown" },
    async (uri, { vault }) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await safeIndex(ctx, String(vault), "index", indexText) }] }),
  );
  server.registerResource(
    "vault-llms",
    new ResourceTemplate("brain://{vault}/llms.txt", {
      list: async () => ({ resources: (await vaultRows()).map((v) => ({ uri: `brain://${v.slug}/llms.txt`, name: `llms.txt di ${v.name}`, mimeType: "text/plain" })) }),
    }),
    { title: "llms.txt del vault", description: "Mappa compatta del vault per agenti: titolo, id, costo in token, sintesi", mimeType: "text/plain" },
    async (uri, { vault }) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: await safeIndex(ctx, String(vault), "llms", indexText) }] }),
  );
  server.registerResource(
    "vault-changes",
    new ResourceTemplate("brain://{vault}/changes{?since}", {
      list: async () => ({ resources: (await vaultRows()).map((v) => ({ uri: `brain://${v.slug}/changes`, name: `Modifiche di ${v.name} (ultime 24 ore)`, mimeType: "text/markdown" })) }),
    }),
    {
      title: "Modifiche del vault",
      description: "Pagine scritte e documenti aggiunti da una data (since, ISO; predefinito le ultime 24 ore). Termina con l'indirizzo della lettura successiva.",
      mimeType: "text/markdown",
    },
    async (uri, { vault, since }) => {
      let text: string;
      try {
        text = await brainChanges(ctx, { vault: String(vault), ...(since ? { since: String(since) } : {}) });
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        text = e.message;
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );
  server.registerResource(
    "vault-page",
    new ResourceTemplate("brain://{vault}/page/{id}", { list: undefined }),
    { title: "Pagina", description: "Una pagina del vault, tagliata a 4000 token", mimeType: "text/markdown" },
    async (uri, { vault, id }) => {
      const v = await vaultBySlug(String(vault));
      const p = readerOf(ctx, v ? [v.id] : []);
      const r = v ? await readPage(ctx.sql, p, String(id), { maxTokens: 4000 }) : undefined;
      if (r) ctx.audit?.write({ principalId: ctx.account.id, action: "page.read", resource: r.id, ...ctx.meta, data: { classification: r.classification, tokens: r.contentTokens, via: "mcp" } });
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: r ? r.content : "Pagina non trovata o non accessibile." }] };
    },
  );

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------
  const ask = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  const rules =
    "Usa i tool di HiveVault: brain_search, poi brain_read con max_tokens 1500 sulle 2-3 pagine migliori, brain_neighbors e brain_timeline se servono. " +
    "Cita ogni fatto con l'id tra ^[ ]. Distingui lo stato attuale dalla storia. Segnala informazioni in conflitto. Se la memoria non lo sa, dillo.";

  server.registerPrompt(
    "cosa-sappiamo-di",
    { title: "Cosa sappiamo di…", description: "Riassunto di ciò che la memoria aziendale sa su un argomento", argsSchema: { argomento: z.string().describe("Persona, cliente, progetto o tema") } },
    ({ argomento }) => ask(`Dimmi cosa sappiamo di «${argomento}». ${rules} Chiudi con le lacune: cosa la memoria non dice.`),
  );
  server.registerPrompt(
    "stato-cliente",
    { title: "Stato di un cliente", description: "Situazione attuale di un cliente: contratto, referenti, progetti, questioni aperte", argsSchema: { cliente: z.string() } },
    ({ cliente }) =>
      ask(`Prepara lo stato del cliente «${cliente}»: prodotti e postazioni, rinnovo, referenti, progetti in corso con le scadenze, questioni aperte, ultimi eventi (brain_timeline). ${rules}`),
  );
  server.registerPrompt(
    "prepara-riunione",
    {
      title: "Prepara una riunione",
      description: "Brief per una riunione con una persona o un'azienda",
      argsSchema: { con: z.string().describe("Persona o azienda"), argomento: z.string().optional().describe("Tema della riunione") },
    },
    ({ con, argomento }) =>
      ask(
        `Preparami un brief per la riunione con «${con}»${argomento ? ` su «${argomento}»` : ""}: chi è, relazioni (brain_neighbors), stato attuale, ultimi eventi, questioni aperte, domande da fare. Massimo una pagina. ${rules}`,
      ),
  );

  // the work journal: the thread of the work does not stay only in someone's head
  server.registerPrompt(
    "buongiorno",
    { title: "Buongiorno", description: "Briefing di inizio sessione dal diario di lavoro (non scrive niente)" },
    () =>
      ask(
        "Leggi il diario con brain_journal action «leggi». Dammi un briefing di 5 righe: dove eravamo rimasti, cosa era rimasto aperto, cosa conviene affrontare oggi in ordine di priorità. " +
          "Per i punti aperti che citano clienti o progetti, controlla con brain_timeline se c'è qualcosa di nuovo. Non scrivere niente nella memoria.",
      ),
  );
  server.registerPrompt(
    "chiudi-sessione",
    { title: "Chiudi la sessione", description: "Scrive la nota di diario della sessione: Fatto, Deciso, Aperto" },
    () =>
      ask(
        "Dimmi in 3 righe cosa abbiamo fatto in questa sessione e aspetta il mio ok. Al mio ok, usa brain_journal action «sessione» con summary (una frase), fatto, deciso (con il perché), aperto, " +
          "e links con i titoli delle pagine vere toccate (clienti, progetti, persone: cercale con brain_search, non inventarle). Se non c'è niente da collegare, chiedimi a cosa collegarla.",
      ),
  );
  server.registerPrompt(
    "fine-giornata",
    { title: "Fine giornata", description: "Riassunto della giornata dalle note di sessione di oggi" },
    () =>
      ask(
        "Leggi le note di oggi con brain_journal action «leggi» (limit 10). Dimmi in 3 righe cosa è successo oggi in totale e aspetta il mio ok. " +
          "Al mio ok, usa brain_journal action «giornata»: unisci le sessioni senza ripeterle riga per riga, con fatto, deciso, aperto e links alle pagine principali toccate.",
      ),
  );

  return server;
}

async function safeIndex(ctx: ToolContext, vault: string, name: "index" | "llms", fn: (v: string, n: "index" | "llms") => Promise<string>): Promise<string> {
  try {
    const text = await fn(vault, name);
    ctx.audit?.write({ principalId: ctx.account.id, action: "mcp.resource", resource: `${vault}/${name}`, ...ctx.meta, data: { via: "mcp" } });
    return text;
  } catch (e) {
    return e instanceof ToolError ? e.message : "Indice non disponibile.";
  }
}
