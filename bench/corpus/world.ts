/**
 * Deterministic synthetic company world (D9: no real sample available).
 * The same seed always produces the same world, documents and ground truth.
 */

export type Rng = () => number;

/** mulberry32: small, fast, deterministic PRNG. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const int = (r: Rng, min: number, max: number): number => min + Math.floor(r() * (max - min + 1));
export function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/** Person name code: 0 -> "AAA", 1 -> "AAB", ... (letters only, at least three). */
function nameCode(n: number): string {
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return s.padStart(3, "A");
}
const COMPANY_A = ["Alpi", "Adriatica", "Lariana", "Padana", "Tirrena", "Dolomiti", "Etrusca", "Ligure", "Sabina", "Orobica", "Brianzola", "Euganea", "Salentina", "Murgiana", "Apuana"] as const;
const COMPANY_B = ["Meccanica", "Logistica", "Tessile", "Alimentare", "Farmaceutica", "Energia", "Assicurazioni", "Banca", "Retail", "Costruzioni", "Trasporti", "Sanità", "Telecomunicazioni", "Chimica", "Editoria"] as const;
const COMPANY_FORM = ["S.p.A.", "S.r.l.", "S.r.l.", "S.p.A.", "Group"] as const;
const CITIES = ["Milano", "Torino", "Bologna", "Verona", "Bergamo", "Brescia", "Padova", "Firenze", "Roma", "Napoli", "Bari", "Genova", "Trento", "Udine", "Ancona"] as const;
const PRODUCTS = ["Company example 2", "Company example 3", "Company example 5", "Company example 4", "Company example 6", "Company example 7"] as const;
const PROJECT_WORDS = ["Aurora", "Borea", "Cometa", "Delta", "Eclisse", "Fenice", "Gemini", "Iride", "Libra", "Meridiana", "Nettuno", "Orione", "Pegaso", "Quarzo", "Rubino", "Sirio", "Titano", "Vela", "Zefiro", "Artemide"] as const;
const ROLES = ["sviluppatore backend", "sviluppatrice frontend", "architetto software", "project manager", "analista funzionale", "consulente commerciale", "sistemista", "data engineer", "responsabile qualità", "UX designer"] as const;
export const DATABASES = [
  { name: "PostgreSQL", why: "transazioni affidabili e supporto JSONB" },
  { name: "MySQL", why: "competenze già presenti nel team del cliente" },
  { name: "MongoDB", why: "schema flessibile per i dati di catalogo" },
  { name: "SQL Server", why: "vincolo dell'infrastruttura Microsoft del cliente" },
  { name: "Oracle", why: "licenze già acquistate dal cliente" },
] as const;
export const STACKS = ["Java Spring Boot", "Node.js e TypeScript", "Python FastAPI", ".NET 8", "Angular", "React", "Vue"] as const;

export interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
  org: string; // company id or "us"
}

export interface Client {
  id: string;
  name: string;
  domain: string;
  sector: string;
  city: string;
  product: string;
  seats: number;
  pricePerSeat: number;
  renewal: string; // ISO date
  techContact: string; // person id
  salesContact: string; // person id
  contacts: string[];
}

export interface Project {
  id: string;
  name: string;
  client: string;
  pm: string;
  team: string[];
  stack: string;
  database: (typeof DATABASES)[number];
  start: string;
  deadline: string;
}

export interface World {
  us: { name: string; domain: string };
  people: Map<string, Person>;
  clients: Client[];
  projects: Project[];
  employees: Person[];
  consultants: Person[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const itDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function buildWorld(r: Rng, opts: { clients: number; employees: number; consultants: number; projectsPerClient: number }): World {
  const used = new Set<string>();
  const people = new Map<string, Person>();
  const person = (org: string, domain: string, role: string): Person => {
    // Placeholder names, no real-sounding people. Two draws keep the random stream of the
    // other fields as it was with the former first-name / last-name lists.
    r();
    r();
    const name = `Nome Cognome${nameCode(used.size)}`;
    used.add(name);
    const id = `per-${slug(name)}`;
    const [f, ...l] = name.split(" ");
    const p: Person = { id, name, role, org, email: `${slug(f!)}.${slug(l.join(""))}@${domain}` };
    people.set(id, p);
    return p;
  };

  const us = { name: "Company example 1", domain: "company-example-1.example" };
  const employees = Array.from({ length: opts.employees }, () => person("us", us.domain, pick(r, ROLES)));
  const consultants = Array.from({ length: opts.consultants }, () => person("consulting", "consulenti.example", "consulente esterno"));

  const clients: Client[] = [];
  const names = new Set<string>();
  for (let i = 0; i < opts.clients; i++) {
    let name = "";
    do name = `${pick(r, COMPANY_A)} ${pick(r, COMPANY_B)} ${pick(r, COMPANY_FORM)}`;
    while (names.has(name));
    names.add(name);
    const id = `cli-${slug(name)}`;
    const domain = `${slug(name).split("-").slice(0, 2).join("")}.example`;
    const contacts = Array.from({ length: int(r, 2, 4) }, (_, k) => person(id, domain, k === 0 ? "responsabile IT" : k === 1 ? "responsabile acquisti" : "referente operativo"));
    const renewal = new Date(Date.UTC(2026, int(r, 0, 11), int(r, 1, 28)));
    clients.push({
      id,
      name,
      domain,
      sector: name.split(" ")[1]!,
      city: pick(r, CITIES),
      product: pick(r, PRODUCTS),
      seats: int(r, 2, 40) * 25,
      pricePerSeat: int(r, 8, 45),
      renewal: isoDate(renewal),
      techContact: contacts[0]!.id,
      salesContact: contacts[1]!.id,
      contacts: contacts.map((c) => c.id),
    });
  }

  const projects: Project[] = [];
  const projectNames = shuffle(r, [...PROJECT_WORDS]);
  let pn = 0;
  for (const c of clients) {
    for (let k = 0; k < opts.projectsPerClient; k++) {
      const word = projectNames[pn % projectNames.length]!;
      const name = pn < projectNames.length ? `Progetto ${word}` : `Progetto ${word} ${Math.floor(pn / projectNames.length) + 1}`;
      pn++;
      const start = new Date(Date.UTC(2025, int(r, 0, 11), int(r, 1, 28)));
      const deadline = new Date(start.getTime() + int(r, 90, 300) * 86400000);
      const team = shuffle(r, [...employees]).slice(0, int(r, 2, 5));
      projects.push({
        id: `prj-${slug(name)}`,
        name,
        client: c.id,
        pm: (employees.find((e) => e.role === "project manager" && !projects.some((p) => p.pm === e.id)) ?? pick(r, employees)).id,
        team: team.map((t) => t.id),
        stack: pick(r, STACKS),
        database: pick(r, DATABASES),
        start: isoDate(start),
        deadline: isoDate(deadline),
      });
    }
  }
  return { us, people, clients, projects, employees, consultants };
}
