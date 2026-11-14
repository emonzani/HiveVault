/**
 * Synthetic corpus generator with ground truth (D9).
 *
 * Writes realistic Italian business documents (eml, md, txt, csv) about a fictional software
 * company, its clients, projects and consultants, plus:
 *  - truth/facts.jsonl           every fact, with validity date and source documents
 *  - truth/contradictions.jsonl  documents that state a wrong value on purpose
 *  - truth/questions.jsonl       evaluation questions with the expected answer and sources
 *
 * Facts change over time (seats increase, new technical contact, deadline moved, database
 * replaced): the expected answer is the latest value, which tests "compiled truth + timeline".
 *
 * Usage: npm run corpus -- --seed 42 --clients 12 --noise 200 --out data/corpus/dev
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildWorld, DATABASES, int, isoDate, itDate, pick, rng, type Client, type Person, type Project, type World } from "./world.ts";

interface Args {
  seed: number;
  clients: number;
  employees: number;
  consultants: number;
  projectsPerClient: number;
  noise: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seed: 42, clients: 12, employees: 24, consultants: 6, projectsPerClient: 2, noise: 200, out: "data/corpus/dev" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!.replace(/^--/, "") as keyof Args;
    const v = argv[i + 1]!;
    (a as unknown as Record<string, unknown>)[k] = k === "out" ? v : Number(v);
  }
  return a;
}

interface Fact {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  validFrom: string;
  sources: string[];
  supersedes?: string;
}
interface Doc {
  path: string;
  date: string;
  body: string;
}
interface Question {
  id: string;
  question: string;
  answer: string;
  factIds: string[];
  sources: string[];
  /** "incrocio": two facts of two documents, joined by an entity (project -> client -> fact); the answer lists both ("client; value"). */
  kind: "lookup" | "updated" | "relational" | "decision" | "contradiction" | "incrocio";
}

const args = parseArgs(process.argv.slice(2));
const r = rng(args.seed);
const world = buildWorld(r, args);
const P = (id: string): Person => world.people.get(id)!;
const C = (id: string): Client => world.clients.find((c) => c.id === id)!;

const docs: Doc[] = [];
const facts: Fact[] = [];
const contradictions: { doc: string; factId: string; statedValue: string; trueValue: string }[] = [];
let factSeq = 0;
let msgSeq = 0;

function fact(subject: string, predicate: string, value: string, validFrom: string, source: string, supersedes?: Fact): Fact {
  const f: Fact = { id: `f${++factSeq}`, subject, predicate, value, validFrom, sources: [source], ...(supersedes ? { supersedes: supersedes.id } : {}) };
  facts.push(f);
  return f;
}
const latest = (subject: string, predicate: string) =>
  facts.filter((f) => f.subject === subject && f.predicate === predicate).sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1)!;

const addDays = (iso: string, d: number) => isoDate(new Date(Date.parse(iso) + d * 86400000));
const rfcDate = (iso: string, hour: number) => new Date(Date.parse(iso) + hour * 3600000).toUTCString().replace("GMT", "+0000");

function email(o: { from: Person; to: Person[]; cc?: Person[]; subject: string; date: string; body: string; thread?: string; dir: string }): { path: string; messageId: string } {
  const messageId = `<${++msgSeq}.${args.seed}@${o.from.email.split("@")[1]}>`;
  const file = `email/${o.dir}/${o.date}-${String(msgSeq).padStart(5, "0")}.eml`;
  const head = [
    `From: ${o.from.name} <${o.from.email}>`,
    `To: ${o.to.map((p) => `${p.name} <${p.email}>`).join(", ")}`,
    ...(o.cc?.length ? [`Cc: ${o.cc.map((p) => `${p.name} <${p.email}>`).join(", ")}`] : []),
    `Subject: ${o.subject}`,
    `Date: ${rfcDate(o.date, int(r, 8, 18))}`,
    `Message-ID: ${messageId}`,
    ...(o.thread ? [`In-Reply-To: ${o.thread}`, `References: ${o.thread}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const signature = `\n\n--\n${o.from.name}\n${o.from.role}${o.from.org === "us" ? `\n${world.us.name}` : ""}\n`;
  docs.push({ path: file, date: o.date, body: `${head.join("\r\n")}\r\n\r\n${o.body.trim()}${signature}`.replace(/\r?\n/g, "\r\n") });
  return { path: file, messageId };
}

const firstName = (p: Person) => p.name.split(" ")[0]!;
const us = (role?: string) => (role ? world.employees.find((e) => e.role === role) : undefined) ?? pick(r, world.employees);

// ---------------------------------------------------------------------------
// Clients: offer, contract, changes over time
// ---------------------------------------------------------------------------
for (const c of world.clients) {
  const sales = us("consulente commerciale");
  const tech = P(c.techContact);
  const buyer = P(c.salesContact);
  const offerDate = isoDate(new Date(Date.UTC(2025, int(r, 0, 5), int(r, 1, 28))));
  const offerPath = `offers/${offerDate}-offerta-${c.id.slice(4)}.txt`;
  docs.push({
    path: offerPath,
    date: offerDate,
    body: `OFFERTA COMMERCIALE N. ${int(r, 100, 999)}/${offerDate.slice(0, 4)}
Data: ${itDate(offerDate)}
Cliente: ${c.name} (${c.city})
Alla cortese attenzione di: ${buyer.name}, ${buyer.role}

Oggetto: fornitura in abbonamento di ${c.product}

1. Prodotto: ${c.product}, versione cloud, con assistenza standard.
2. Numero di postazioni: ${c.seats}.
3. Canone per postazione: ${c.pricePerSeat},00 EUR al mese, IVA esclusa.
4. Durata: 12 mesi, rinnovo tacito salvo disdetta con 60 giorni di preavviso.
5. Avvio previsto entro 30 giorni dalla firma.

Totale annuo stimato: ${(c.seats * c.pricePerSeat * 12).toLocaleString("it-IT")},00 EUR.

${sales.name}
${sales.role}, ${world.us.name}
`,
  });
  const fProduct = fact(c.id, "prodotto", c.product, offerDate, offerPath);
  let fSeats = fact(c.id, "postazioni", String(c.seats), offerDate, offerPath);
  fact(c.id, "canone_postazione_eur", String(c.pricePerSeat), offerDate, offerPath);
  void fProduct;

  const signDate = addDays(offerDate, int(r, 10, 40));
  const signed = email({
    from: buyer,
    to: [sales],
    cc: [tech],
    subject: `Firma contratto ${c.product} - ${c.name}`,
    date: signDate,
    dir: c.id.slice(4),
    body: `Buongiorno ${firstName(sales)},

vi confermo che abbiamo firmato il contratto per ${c.product} alle condizioni della vostra offerta (${c.seats} postazioni).
Il contratto scade il ${itDate(c.renewal)} e si rinnova in automatico.

Per gli aspetti tecnici il vostro riferimento sarà ${tech.name} (${tech.email}), nostro ${tech.role}.

Cordiali saluti,
${buyer.name}`,
  });
  fact(c.id, "scadenza_contratto", c.renewal, signDate, signed.path);
  let fTech = fact(c.id, "referente_tecnico", tech.name, signDate, signed.path);
  fact(c.id, "referente_acquisti", buyer.name, signDate, signed.path);

  if (r() < 0.4) {
    const d = addDays(signDate, int(r, 60, 240));
    const newSeats = c.seats + int(r, 1, 8) * 25;
    const e = email({
      from: buyer,
      to: [sales],
      subject: `Re: ampliamento postazioni ${c.product}`,
      date: d,
      dir: c.id.slice(4),
      thread: signed.messageId,
      body: `Ciao ${firstName(sales)},

dopo l'apertura della nuova sede ci servono più licenze: portiamo le postazioni di ${c.product} da ${c.seats} a ${newSeats}, con decorrenza dal mese prossimo.
Il canone per postazione resta invariato.

Grazie,
${firstName(buyer)}`,
    });
    fSeats = fact(c.id, "postazioni", String(newSeats), d, e.path, fSeats);
  }

  if (c.contacts.length > 2 && r() < 0.3) {
    const d = addDays(signDate, int(r, 90, 300));
    const newTech = P(c.contacts[2]!);
    const e = email({
      from: tech,
      to: [sales, ...world.employees.slice(0, 1)],
      cc: [newTech],
      subject: `Cambio referente tecnico - ${c.name}`,
      date: d,
      dir: c.id.slice(4),
      body: `Buongiorno a tutti,

vi informo che dal ${itDate(addDays(d, 7))} cambio ruolo all'interno di ${c.name}.
Il nuovo referente tecnico per ${c.product} sarà ${newTech.name} (${newTech.email}), che legge in copia.
Vi chiedo di indirizzare a questo nuovo contatto tutte le comunicazioni tecniche.

Saluti,
${tech.name}`,
    });
    fTech = fact(c.id, "referente_tecnico", newTech.name, d, e.path, fTech);
  }
  void fTech;
  void fSeats;
}

// ---------------------------------------------------------------------------
// Projects: kickoff minutes, technical analysis, status emails, consultant chat
// ---------------------------------------------------------------------------
for (const p of world.projects) {
  const c = C(p.client);
  const pm = P(p.pm);
  const team = p.team.map(P);
  const tech = P(c.techContact);
  const kick = `minutes/${p.start}-kickoff-${p.id.slice(4)}.md`;
  docs.push({
    path: kick,
    date: p.start,
    body: `# Verbale di kickoff — ${p.name}

**Data:** ${itDate(p.start)}
**Cliente:** ${c.name}
**Partecipanti:** ${[pm, ...team, tech].map((x) => x.name).join(", ")}

## Obiettivo
Realizzare per ${c.name} un'integrazione su misura di ${c.product}, con un portale dedicato agli utenti di ${c.city}.

## Organizzazione
- Project manager: ${pm.name}
- Team di sviluppo: ${team.map((t) => `${t.name} (${t.role})`).join(", ")}
- Referente lato cliente: ${tech.name}
- Stack tecnologico proposto: ${p.stack}

## Pianificazione
- Avvio lavori: ${itDate(p.start)}
- Consegna prevista: **${itDate(p.deadline)}**
- Stato di avanzamento ogni due settimane, via email.

## Azioni
- [ ] ${team[0]!.name}: preparare l'analisi tecnica entro due settimane
- [ ] ${pm.name}: condividere il piano di progetto con ${tech.name}
`,
  });
  fact(p.id, "cliente", c.name, p.start, kick);
  fact(p.id, "project_manager", pm.name, p.start, kick);
  fact(p.id, "team", team.map((t) => t.name).sort().join("; "), p.start, kick);
  fact(p.id, "stack", p.stack, p.start, kick);
  let fDeadline = fact(p.id, "consegna", p.deadline, p.start, kick);

  const anaDate = addDays(p.start, int(r, 10, 20));
  const ana = `analysis/${anaDate}-analisi-tecnica-${p.id.slice(4)}.md`;
  const alt = DATABASES.filter((d) => d.name !== p.database.name).slice(0, 2);
  docs.push({
    path: ana,
    date: anaDate,
    body: `# Analisi tecnica — ${p.name}

Autore: ${team[0]!.name} · Revisione: ${pm.name} · Data: ${itDate(anaDate)}

## Contesto
Il cliente ${c.name} usa ${c.product} con ${latest(c.id, "postazioni").value} postazioni. Il nuovo portale deve leggere i dati in tempo reale.

## Architettura
- Backend: ${p.stack}
- Database: **${p.database.name}**
- Integrazione con ${c.product} tramite API REST e code di messaggi.

## Decisione: database
Scegliamo ${p.database.name} per ${p.database.why}.
Alternative valutate: ${alt.map((a) => a.name).join(" e ")}, scartate per costi o per mancanza di competenze.

## Rischi
1. Volumi di dati superiori alle stime iniziali.
2. Disponibilità del referente ${tech.name} nei mesi estivi.
`,
  });
  let fDb = fact(p.id, "database", p.database.name, anaDate, ana);
  fact(p.id, "motivo_database", p.database.why, anaDate, ana);

  // status emails, sometimes moving the deadline, sometimes stating a wrong one
  let thread: string | undefined;
  const nStatus = int(r, 2, 4);
  for (let k = 0; k < nStatus; k++) {
    const d = addDays(p.start, 20 + k * int(r, 14, 30));
    let body = `Ciao ${firstName(tech)},

aggiornamento su ${p.name}: completate le attività dello sprint ${k + 1} (${pick(r, ["autenticazione", "anagrafiche", "reportistica", "integrazione con " + c.product, "migrazione dati"])}).
`;
    if (k === 1 && r() < 0.3) {
      const moved = addDays(fDeadline.value, int(r, 2, 6) * 7);
      body += `\nPurtroppo dobbiamo spostare la consegna dal ${itDate(fDeadline.value)} al ${itDate(moved)}: l'integrazione richiede più test del previsto.\n`;
      const e = email({ from: pm, to: [tech], cc: team.slice(0, 2), subject: `Stato avanzamento ${p.name} - nuova data di consegna`, date: d, dir: p.id.slice(4), thread, body: body + `\nUn saluto,\n${firstName(pm)}` });
      fDeadline = fact(p.id, "consegna", moved, d, e.path, fDeadline);
      thread = e.messageId;
      continue;
    }
    if (k === nStatus - 1 && r() < 0.15) {
      const wrong = addDays(fDeadline.value, -int(r, 1, 3) * 7);
      body += `\nConfermiamo la consegna per il ${itDate(wrong)}.\n`;
      const e = email({ from: team[0]!, to: [tech], subject: `Re: stato avanzamento ${p.name}`, date: d, dir: p.id.slice(4), thread, body: body + `\nCiao,\n${firstName(team[0]!)}` });
      contradictions.push({ doc: e.path, factId: fDeadline.id, statedValue: wrong, trueValue: fDeadline.value });
      thread = e.messageId;
      continue;
    }
    body += `\nLa consegna resta confermata per il ${itDate(fDeadline.value)}.\n`;
    const e = email({ from: pm, to: [tech], subject: k === 0 ? `Stato avanzamento ${p.name}` : `Re: stato avanzamento ${p.name}`, date: d, dir: p.id.slice(4), thread, body: body + `\nUn saluto,\n${firstName(pm)}` });
    fDeadline.sources.push(e.path);
    thread = e.messageId;
  }

  // consultant chat, sometimes leading to a database change
  const consultant = pick(r, world.consultants);
  const chatDate = addDays(anaDate, int(r, 30, 80));
  const switchDb = r() < 0.2;
  const newDb = switchDb ? pick(r, DATABASES.filter((d) => d.name !== p.database.name)) : p.database;
  const chatPath = `chats/${chatDate}-${consultant.id.slice(4)}-${p.id.slice(4)}.txt`;
  const lines = [
    `[${itDate(chatDate)} 10:02] ${consultant.name}: ciao ${firstName(team[0]!)}, ho visto i tempi di risposta di ${p.name}`,
    `[${itDate(chatDate)} 10:04] ${team[0]!.name}: sì, le query sui report superano i 3 secondi con ${p.database.name}`,
    `[${itDate(chatDate)} 10:07] ${consultant.name}: avete provato con indici composti sulla tabella ordini?`,
    `[${itDate(chatDate)} 10:09] ${team[0]!.name}: non ancora, il volume è cresciuto molto da quando ${c.name} ha più postazioni`,
  ];
  if (switchDb) {
    lines.push(
      `[${itDate(chatDate)} 10:15] ${consultant.name}: secondo me conviene passare a ${newDb.name}, per ${newDb.why}`,
      `[${itDate(chatDate)} 10:21] ${team[0]!.name}: ne parlo con ${pm.name} e aggiorniamo l'analisi`,
    );
  } else {
    lines.push(`[${itDate(chatDate)} 10:15] ${consultant.name}: allora partite dagli indici, ${p.database.name} regge senza problemi`);
  }
  docs.push({ path: chatPath, date: chatDate, body: lines.join("\n") + "\n" });
  if (switchDb) {
    const revDate = addDays(chatDate, int(r, 3, 10));
    const rev = `analysis/${revDate}-revisione-database-${p.id.slice(4)}.md`;
    docs.push({
      path: rev,
      date: revDate,
      body: `# Revisione dell'analisi tecnica — ${p.name}

Data: ${itDate(revDate)} · Approvata da: ${pm.name}

## Decisione
Il database del progetto passa da ${p.database.name} a **${newDb.name}**, per ${newDb.why}.
La decisione segue il confronto con il consulente ${consultant.name}.

## Impatto
Migrazione dei dati in due settimane; la data di consegna non cambia.
`,
    });
    fDb = fact(p.id, "database", newDb.name, revDate, rev, fDb);
    fact(p.id, "motivo_database", newDb.why, revDate, rev);
  }
  void fDb;
}

// ---------------------------------------------------------------------------
// Orders CSV (one file per quarter) and noise documents
// ---------------------------------------------------------------------------
for (const q of ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"]) {
  const rows = ["data;cliente;prodotto;postazioni;importo_eur"];
  const month = (Number(q.slice(-1)) - 1) * 3 + 1;
  for (const c of world.clients) {
    if (r() < 0.25) continue;
    const date = `${q.slice(0, 4)}-${String(month + int(r, 0, 2)).padStart(2, "0")}-${String(int(r, 1, 28)).padStart(2, "0")}`;
    const seats = latest(c.id, "postazioni").value;
    rows.push(`${date};${c.name};${c.product};${seats};${(Number(seats) * c.pricePerSeat * 3).toFixed(2).replace(".", ",")}`);
  }
  docs.push({ path: `orders/ordini-${q}.csv`, date: `${q.slice(0, 4)}-${String(month).padStart(2, "0")}-01`, body: rows.join("\n") + "\n" });
}

const NOISE_TOPICS = [
  ["Newsletter interna", "Ricordiamo a tutti di aggiornare la password della VPN entro fine mese e di completare il corso sulla sicurezza informatica."],
  ["Mensa aziendale", "Da lunedì il menu della mensa cambia fornitore. Le prenotazioni restano aperte fino alle 10:30."],
  ["Ferie estive", "Le richieste di ferie per agosto vanno inserite nel portale HR entro il 31 maggio."],
  ["Manutenzione server", "Sabato dalle 22:00 alle 02:00 il server di posta non sarà disponibile per aggiornamenti."],
  ["Formazione", "È disponibile il nuovo corso interno su Kubernetes. Iscrizioni dal portale formazione."],
] as const;
for (let i = 0; i < args.noise; i++) {
  const [title, text] = pick(r, NOISE_TOPICS);
  const d = isoDate(new Date(Date.UTC(2025, 0, 1) + int(r, 0, 640) * 86400000));
  const author = pick(r, world.employees);
  docs.push({ path: `notes/${d}-nota-${String(i).padStart(4, "0")}.md`, date: d, body: `# ${title}\n\n${text}\n\nAutore: ${author.name}, ${itDate(d)}\n` });
}

// ---------------------------------------------------------------------------
// Evaluation questions from the latest facts
// ---------------------------------------------------------------------------
const questions: Question[] = [];
let qn = 0;
const q = (question: string, f: Fact, kind: Question["kind"], answer = f.value) =>
  questions.push({ id: `q${++qn}`, question, answer, factIds: [f.id], sources: f.sources, kind });

for (const c of world.clients) {
  const tech = latest(c.id, "referente_tecnico");
  q(`Chi è il referente tecnico di ${c.name}?`, tech, tech.supersedes ? "updated" : "lookup");
  const seats = latest(c.id, "postazioni");
  q(`Quante postazioni di ${c.product} ha ${c.name}?`, seats, seats.supersedes ? "updated" : "lookup");
  q(`Quando scade il contratto di ${c.name}?`, latest(c.id, "scadenza_contratto"), "lookup", itDate(latest(c.id, "scadenza_contratto").value));
}
for (const p of world.projects) {
  q(`Chi è il project manager del ${p.name}?`, latest(p.id, "project_manager"), "lookup");
  const db = latest(p.id, "database");
  const why = latest(p.id, "motivo_database");
  questions.push({
    id: `q${++qn}`,
    question: `Quale database usa il ${p.name} e perché?`,
    answer: `${db.value}: ${why.value}`,
    factIds: [db.id, why.id],
    sources: [...new Set([...db.sources, ...why.sources])],
    kind: db.supersedes ? "updated" : "decision",
  });
  const dl = latest(p.id, "consegna");
  const contra = contradictions.find((x) => x.factId === dl.id);
  q(`Qual è la data di consegna del ${p.name}?`, dl, contra ? "contradiction" : dl.supersedes ? "updated" : "lookup", itDate(dl.value));
}
for (const e of world.employees) {
  const ps = world.projects.filter((p) => p.team.includes(e.id) || p.pm === e.id);
  if (ps.length < 2) continue;
  const fs = ps.map((p) => latest(p.id, p.pm === e.id ? "project_manager" : "team"));
  questions.push({
    id: `q${++qn}`,
    question: `Su quali progetti lavora ${e.name}?`,
    answer: ps.map((p) => p.name).sort().join("; "),
    factIds: fs.map((f) => f.id),
    sources: [...new Set(fs.flatMap((f) => f.sources))],
    kind: "relational",
  });
}

// Cross questions: the project names its client in the kickoff, the client's facts are in the
// contract and the emails. No single document holds the answer.
for (const p of world.projects) {
  const c = C(p.client);
  const fc = latest(p.id, "cliente");
  const cross = (question: string, f: Fact, answer: string) => {
    if (f.sources.every((x) => fc.sources.includes(x))) return; // same document: not a cross question
    questions.push({ id: `q${++qn}`, question, answer, factIds: [fc.id, f.id], sources: [...new Set([...fc.sources, ...f.sources])], kind: "incrocio" });
  };
  const tech = latest(c.id, "referente_tecnico");
  cross(`Chi è il referente tecnico del cliente del ${p.name}?`, tech, `${c.name}; ${tech.value}`);
  const end = latest(c.id, "scadenza_contratto");
  cross(`Quando scade il contratto del cliente per cui lavora il ${p.name}?`, end, `${c.name}; ${itDate(end.value)}`);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
const out = path.resolve(args.out);
await rm(out, { recursive: true, force: true });
let bytes = 0;
for (const d of docs) {
  const file = path.join(out, "docs", d.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, d.body, "utf8");
  bytes += Buffer.byteLength(d.body);
}
await mkdir(path.join(out, "truth"), { recursive: true });
const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
await writeFile(path.join(out, "truth", "facts.jsonl"), jsonl(facts));
await writeFile(path.join(out, "truth", "contradictions.jsonl"), jsonl(contradictions));
await writeFile(path.join(out, "truth", "questions.jsonl"), jsonl(questions));
const byType: Record<string, number> = {};
for (const d of docs) {
  const ext = path.extname(d.path).slice(1);
  byType[ext] = (byType[ext] ?? 0) + 1;
}
const manifest = {
  seed: args.seed,
  generatedAt: new Date().toISOString(),
  world: {
    clients: world.clients.length,
    projects: world.projects.length,
    employees: world.employees.length,
    consultants: world.consultants.length,
    people: world.people.size,
  },
  documents: docs.length,
  byType,
  bytes,
  facts: facts.length,
  supersededFacts: facts.filter((f) => f.supersedes).length,
  contradictions: contradictions.length,
  questions: questions.length,
  questionsByKind: questions.reduce<Record<string, number>>((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {}),
};
await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));

export type { World };
