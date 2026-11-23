/**
 * Demo data for the web interface (development only): one user with a personal cell, three
 * hive spaces, compiled pages built from the synthetic world (clients, people, products,
 * projects, decisions) with wikilinks and citations to real uploaded sources, an API account
 * that the cloud agent uses, and a few audited reads for the "Cosa ha letto l'agente cloud" panel.
 *
 * Usage: npx tsx scripts/seed-demo.ts [--clients 12]
 * The TOTP secret of the user "demo" and the MCP key of "agent-demo" go to data/dev-demo.json; `npx tsx scripts/dev-totp.ts`
 * prints the current code. Running the script again replaces the demo data.
 */
import "../packages/db/src/env.ts"; // .env first: the model settings are read when the services start
import { writeFileSync } from "node:fs";
import path from "node:path";
import { base32Decode, totp } from "@cb/auth";
import { PageStore } from "@cb/brain";
import { buildIndexes, promoteSpace, setFeeds } from "@cb/hive";
import { buildWorld, itDate, rng, type Client, type Person } from "../bench/corpus/world.ts";
import { loadServerConfig } from "../packages/server/src/config.ts";
import { createServices } from "../packages/server/src/services.ts";

const argv = process.argv.slice(2);
const clients = Number(argv[argv.indexOf("--clients") + 1] || 12) || 12;
const cfg = loadServerConfig();
const s = await createServices(cfg, { models: false, workers: true });
const sql = s.sql;
const pages = new PageStore(sql);
const r = rng(7);
const world = buildWorld(r, { clients, employees: 18, consultants: 5, projectsPerClient: 2 });

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
const SLUGS = ["demo-cella", "demo-cella-2", "demo-clienti", "demo-tecnico", "demo-direzione"];
for (const slug of SLUGS) {
  const v = await s.vaults.get(slug);
  if (v) await s.vaults.delete(v.id);
}
await sql`delete from principals where name in ('demo', 'nome.cognomeiii', 'agent-demo')`;

// ---------------------------------------------------------------------------
// Principals and vaults
// ---------------------------------------------------------------------------
const demo = await s.auth.principals.createUser({ username: "demo", displayName: "Nome CognomeBBB", email: "nome.cognomebbb@company-example-1.example", role: "member", clearance: 2 });
const { code } = await s.auth.totp.createEnrollment(demo.id, null);
const st = await s.auth.totp.startEnrollment(code);
await s.auth.enrollConfirm(code, totp(base32Decode(st.secretBase32)), { userAgent: "seed-demo" });
writeFileSync(path.join(cfg.dataDir, "dev-demo.json"), JSON.stringify({ username: "demo", secret: st.secretBase32 }, null, 2));

const cell = await s.vaults.create({ kind: "cell", slug: "demo-cella", name: "Cella di Nome CognomeBBB", owner: `user:${demo.id}` });
const hive = await s.vaults.create({ kind: "space", slug: "demo-clienti", name: "Clienti", defaultClassification: 1 });
const tech = await s.vaults.create({ kind: "space", slug: "demo-tecnico", name: "Tecnico", defaultClassification: 1 });
await s.vaults.create({ kind: "space", slug: "demo-direzione", name: "Direzione", defaultClassification: 3 });
// Nome CognomeBBB curates the client space: the conflicts between the cells reach her queue
await s.auth.access.grant(demo.id, hive.id, "curate", null);
const other = await s.auth.principals.createUser({ username: "nome.cognomeiii", displayName: "Nome CognomeIII", role: "member", clearance: 2 });
const cellOther = await s.vaults.create({ kind: "cell", slug: "demo-cella-2", name: "Cella di Nome CognomeIII", owner: `user:${other.id}` });
await setFeeds(sql, hive.id, [{ cellId: cell.id }, { cellId: cellOther.id }]);
await s.auth.access.grant(demo.id, tech.id, "read", null);

const agent = await s.auth.principals.createApiAccount({ name: "agent-demo", displayName: "Agente cloud · vendite", scopes: ["read", "write"], clearance: 1 });
// API key for the MCP server of the development server (data/ is ignored by git)
const { key: agentKey } = await s.auth.apiKeys.issue(agent.id, "Agente cloud (sviluppo)");
writeFileSync(path.join(cfg.dataDir, "dev-demo.json"), JSON.stringify({ username: "demo", secret: st.secretBase32, mcpKey: agentKey }, null, 2));
await s.auth.access.grant(agent.id, hive.id, "read", null);
await s.auth.access.grant(agent.id, cell.id, "read", null);

// ---------------------------------------------------------------------------
// Sources: one short document per client, indexed (I1) so citations resolve to chunks
// ---------------------------------------------------------------------------
const person = (id: string): Person => world.people.get(id)!;
const product = (c: Client) => c.product;
const eur = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2 });

const sourceOf = new Map<string, string>();
for (const c of world.clients) {
  const tc = person(c.techContact);
  const sc = person(c.salesContact);
  const doc = [
    `# Contratto e referenti: ${c.name}`,
    ``,
    `${c.name} (${c.sector}, ${c.city}) usa ${product(c)} con ${c.seats} postazioni a ${eur(c.pricePerSeat)} € al mese ciascuna.`,
    `Il contratto si rinnova il ${itDate(c.renewal)}.`,
    ``,
    `## Referenti`,
    ``,
    `Referente tecnico: ${tc.name} (${tc.role}, ${tc.email}). Referente commerciale: ${sc.name} (${sc.email}).`,
    ``,
    `## Note dell'ultima riunione`,
    ``,
    `Il cliente chiede una revisione della sicurezza prima del rinnovo e valuta l'aumento delle postazioni del 20%.`,
  ].join("\n");
  const up = await s.ingest.upload(hive.id, Buffer.from(doc, "utf8"), `contratto-${c.id}.md`, demo.id, "system", { compile: false, classification: 1 });
  sourceOf.set(c.id, up.source.id);
}
// wait for the parse and index phases (I1)
for (let i = 0; i < 120; i++) {
  const [{ n }] = (await sql`select count(*)::int as n from sources where id = any(${[...sourceOf.values()]}) and level < 1 and status not in ('failed', 'unsupported')`) as unknown as [{ n: number }];
  if (n === 0) break;
  await new Promise((res) => setTimeout(res, 500));
}
const cite = (clientId: string, chunk = 0) => `^[${sourceOf.get(clientId)}#c${chunk}]`;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const products = [...new Set(world.clients.map(product))];
const projectsOf = (c: Client) => world.projects.filter((p) => p.client === c.id);
const write = (vaultId: string, md: string) => pages.upsert({ vaultId, markdown: md, author: "seed-demo" });
const fm = (o: Record<string, unknown>) =>
  `---\n${Object.entries(o)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n")}\n---\n`;

let n = 0;
// Client pages live in the cells of the two account managers; the space "Clienti" gets them
// through the promotion. Nome CognomeBBB follows clients 0-7, Nome CognomeIII 4-11: the shared ones agree, except
// client 5 (Nome CognomeIII has newer seats) and client 6 (another technical contact).
const clientPage = (c: Client, i: number, who: "main" | "other") => {
  const tc = person(c.techContact);
  const sc = person(c.salesContact);
  const short = c.name.replace(/\s+(S\.p\.A\.|S\.r\.l\.|SpA|Srl|S\.n\.c\.)$/i, "");
  const seats = who === "other" && i === 5 ? c.seats + 25 : c.seats;
  const tech = who === "other" && i === 6 ? person(c.contacts.find((x) => x !== c.techContact && x !== c.salesContact) ?? c.salesContact) : tc;
  const body = [
    `# ${c.name}`,
    ``,
    `## Stato attuale`,
    `- Usa [[${product(c)}]] con **${seats} postazioni** a ${eur(c.pricePerSeat)} € al mese ciascuna ${cite(c.id)}`,
    `- Rinnovo del contratto: ${itDate(c.renewal)} ${cite(c.id)}`,
    `- Referente tecnico: [[${tech.name}]] ${cite(c.id)}`,
    `- Referente commerciale: [[${sc.name}]] ${cite(c.id)}`,
    ...(who === "other" ? [`- Ha chiesto una demo del nuovo modulo di reportistica`] : []),
    ``,
    `## Questioni aperte`,
    `- [ ] Revisione della sicurezza prima del rinnovo ${cite(c.id, 2)}`,
    `- [ ] Valutare l'aumento del 20% delle postazioni ${cite(c.id, 2)}`,
    ``,
    `## Progetti`,
    ...projectsOf(c).map((p) => `- [[${p.name}]] · consegna ${itDate(p.deadline)}`),
    ``,
    `## Timeline`,
    `- ${itDate(c.renewal)} · Scadenza del contratto ${cite(c.id)}`,
    ...projectsOf(c).map((p) => `- ${itDate(p.start)} · Avvio del progetto [[${p.name}]]`),
    ``,
    `## Vedi anche`,
    `[[Processo di rinnovo dei contratti]] · [[${product(c)}]]`,
  ].join("\n");
  return (
    fm({
      title: c.name,
      type: "entity/company",
      aliases: [short],
      tags: ["cliente", c.sector.toLowerCase()],
      tldr: `Cliente del settore ${c.sector.toLowerCase()} di ${c.city}: ${seats} postazioni di ${product(c)}, rinnovo il ${itDate(c.renewal)}.`,
      classification: i % 5 === 4 ? "riservato" : "interno",
      confidence: 0.8 + (i % 4) * 0.05,
      sources: [sourceOf.get(c.id)!],
    }) + body
  );
};
for (const [i, c] of world.clients.entries()) {
  if (i <= 7) await write(cell.id, clientPage(c, i, "main"));
  if (i >= 4) await write(cellOther.id, clientPage(c, i, "other"));
  n++;
}

for (const p of products) {
  const users = world.clients.filter((c) => c.product === p);
  await write(
    hive.id,
    fm({ title: p, type: "entity/product", tags: ["prodotto"], tldr: `Prodotto usato da ${users.length} clienti.` }) +
      [`# ${p}`, ``, `## Stato attuale`, `- Clienti attivi: ${users.length} ${cite(users[0]!.id)}`, ``, `## Clienti`, ...users.map((c) => `- [[${c.name}]] · ${c.seats} postazioni`)].join("\n"),
  );
  n++;
}

const peopleInPages = new Set<string>();
for (const c of world.clients) for (const id of [c.techContact, c.salesContact]) peopleInPages.add(id);
for (const p of world.projects) for (const id of [p.pm, ...p.team]) peopleInPages.add(id);
for (const id of peopleInPages) {
  const p = person(id);
  const org = world.clients.find((c) => c.id === p.org);
  const pm = world.projects.filter((x) => x.pm === id);
  const team = world.projects.filter((x) => x.team.includes(id));
  const vault = org ? hive.id : tech.id;
  await write(
    vault,
    fm({ title: p.name, type: "entity/person", tags: [org ? "referente" : "persona"], tldr: `${p.role}${org ? ` presso ${org.name}` : ` di ${world.us.name}`}.` }) +
      [
        `# ${p.name}`,
        ``,
        `## Stato attuale`,
        `- Ruolo: ${p.role}${org ? ` presso [[${org.name}]] ${cite(org.id)}` : ""}`,
        `- Email: ${p.email}`,
        ...(pm.length ? [``, `## Progetti che guida`, ...pm.map((x) => `- [[${x.name}]]`)] : []),
        ...(team.length ? [``, `## Progetti in cui lavora`, ...team.map((x) => `- [[${x.name}]]`)] : []),
      ].join("\n"),
  );
  n++;
}

for (const [i, p] of world.projects.entries()) {
  const c = world.clients.find((x) => x.id === p.client)!;
  await write(
    tech.id,
    fm({ title: p.name, type: "entity/project", tags: ["progetto"], tldr: `Progetto per ${c.name} su ${p.stack} e ${p.database}; consegna il ${itDate(p.deadline)}.` }) +
      [
        `# ${p.name}`,
        ``,
        `## Stato attuale`,
        `- Cliente: [[${c.name}]]`,
        `- Responsabile: [[${person(p.pm).name}]]`,
        `- Tecnologia: ${p.stack}, database ${p.database}`,
        `- Consegna prevista: ${itDate(p.deadline)}`,
        ``,
        `## Gruppo di lavoro`,
        ...p.team.map((t) => `- [[${person(t).name}]]`),
        ``,
        `## Decisioni`,
        `- [[Database di ${p.name}]]`,
      ].join("\n"),
  );
  await write(
    tech.id,
    fm({ title: `Database di ${p.name}`, type: "decision", tags: ["architettura"], tldr: `Per ${p.name} si usa ${p.database}.` }) +
      [
        `# Database di ${p.name}`,
        ``,
        `## Decisione`,
        `Il progetto [[${p.name}]] usa **${p.database}**.${i % 3 === 0 ? " La scelta sostituisce il database proposto all'avvio." : ""}`,
        ``,
        `## Motivi`,
        `- Esperienza del gruppo di lavoro`,
        `- Costi di licenza`,
        ``,
        `## Chi ha deciso`,
        `[[${person(p.pm).name}]], il ${itDate(p.start)}`,
      ].join("\n"),
  );
  n += 2;
}

await write(
  hive.id,
  fm({ title: "Processo di rinnovo dei contratti", type: "concept", tags: ["processo"], tldr: "Come si prepara il rinnovo di un contratto SaaS: 90 giorni prima della scadenza." }) +
    [
      `# Processo di rinnovo dei contratti`,
      ``,
      `## Stato attuale`,
      `- Il referente commerciale contatta il cliente 90 giorni prima della scadenza ${cite(world.clients[0]!.id)}`,
      `- La revisione della sicurezza è richiesta dai clienti del settore sanitario e bancario`,
      ``,
      `## Passi`,
      `1. Controllare utilizzo e postazioni`,
      `2. Preparare l'offerta`,
      `3. Revisione della sicurezza, se richiesta`,
      `4. Firma`,
      ``,
      `## Clienti con rinnovo vicino`,
      ...world.clients.slice(0, 5).map((c) => `- [[${c.name}]] · ${itDate(c.renewal)}`),
    ].join("\n"),
);
n++;

// personal notes in the cell
await write(
  cell.id,
  fm({ title: "Appunti della settimana", type: "note", tags: ["appunti"], classification: "interno" }) +
    [
      `# Appunti della settimana`,
      ``,
      `Riunione con [[${world.clients[0]!.name}]]: confermato l'interesse per altre postazioni.`,
      ``,
      `## Da fare`,
      `- [x] Inviare il riepilogo a [[${person(world.clients[0]!.salesContact).name}]]`,
      `- [ ] Preparare l'offerta per [[${world.clients[2]!.name}]]`,
      `- [ ] Rileggere [[Processo di rinnovo dei contratti]]`,
      ``,
      `> [!tip] Promemoria`,
      `> Le pagine *riservato* non sono mai consultabili dall'agente cloud.`,
    ].join("\n"),
);
await write(
  cell.id,
  fm({ title: "Idee per il nuovo listino", type: "note", tags: ["idee"], classification: "riservato" }) +
    [`# Idee per il nuovo listino`, ``, `- Sconto del 10% oltre le 300 postazioni`, `- Piano annuale con pagamento anticipato`, ``, `Collegato a [[${products[0]}]].`].join("\n"),
);
n += 2;

// a few reads by the API account, as the MCP server will write them (phase 6)
const own = await sql<{ id: string; classification: number; tokens: number }[]>`select id, classification, tokens from pages where vault_id = ${cell.id} and classification <= 1`;
for (const p of own) {
  for (let k = 0; k < 3; k++) {
    await sql`insert into audit_log (at, principal_id, action, resource, data)
      values (now() - make_interval(hours => ${k * 7 + 1}), ${agent.id}, 'page.read', ${p.id}, ${sql.json({ classification: p.classification, tokens: p.tokens, via: "apikey" })})`;
  }
}

// what the dream cycle does at night: promotion to the hive and the generated indexes
const promoted = await promoteSpace(sql, pages, hive.id);
for (const v of [cell, cellOther, hive, tech]) await buildIndexes(sql, v.id);

await new Promise((res) => setTimeout(res, 1500));
console.log(`Demo pronta: ${n} pagine, ${sourceOf.size} sorgenti, vault ${[cell, cellOther, hive, tech].map((v) => v.name).join(", ")} (+ Direzione, non accessibile).`);
console.log(`Alveare «Clienti»: ${promoted.subjects} pagine dalle celle, ${promoted.conflicts} conflitti nella coda di Nome CognomeBBB.`);
console.log(`Accesso: utente "demo", codice TOTP con  npx tsx scripts/dev-totp.ts`);
console.log(`MCP per l'agente cloud: ${cfg.publicUrl}/mcp con la chiave "mcpKey" di ${path.join(cfg.dataDir, "dev-demo.json")}`);
await s.stop();
