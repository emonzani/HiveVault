/**
 * Synthetic data for spike C: Italian business text + clustered vectors.
 *
 * Each chunk belongs to a topic. The topic decides both some keywords of the text and the
 * centroid of the vector, so full-text and vector queries for the same topic hit the same
 * chunks (as with real embeddings), and HNSW recall is measured on a clustered space.
 * Real embeddings of millions of chunks are not possible on CPU in a spike: the vector
 * values are synthetic, the sizes, index structures and query plans are real.
 */
import { rng, type Rng } from "../corpus/world.ts";

const SUBJECTS = ["Il cliente", "Il fornitore", "Il team di progetto", "L'ufficio acquisti", "Il responsabile IT", "La direzione tecnica", "Il consulente esterno", "L'amministrazione", "Il gruppo di lavoro", "Il project manager"];
const VERBS = ["conferma", "richiede", "segnala", "propone", "approva", "rinvia", "verifica", "aggiorna", "contesta", "pianifica", "documenta", "analizza"];
const OBJECTS = ["la consegna", "il preventivo", "il contratto", "la migrazione dei dati", "il collaudo", "la fattura", "il piano di progetto", "l'integrazione", "il rinnovo", "la revisione del codice", "il rilascio in produzione", "la formazione degli utenti"];
const TAILS = ["entro la fine del mese", "dopo la riunione di avanzamento", "secondo quanto concordato", "con una nota tecnica allegata", "in attesa di approvazione", "come indicato nel verbale", "per motivi di budget", "a seguito dei test di carico", "con priorità alta", "nella prossima iterazione"];
const KEYWORDS = [
  "fatturazione", "magazzino", "logistica", "sicurezza", "autenticazione", "reportistica", "anagrafica", "pagamenti", "spedizioni", "ordini",
  "prestazioni", "backup", "licenze", "postazioni", "manutenzione", "conformità", "privacy", "contabilità", "budget", "scadenze",
  "rete", "server", "database", "cloud", "integrazione", "portale", "app", "notifiche", "workflow", "documentale",
  "assistenza", "garanzia", "collaudo", "formazione", "migrazione", "monitoraggio", "audit", "qualità", "rischi", "penali",
];
const NAMES = ["Alpi", "Adriatica", "Lariana", "Padana", "Tirrena", "Dolomiti", "Etrusca", "Ligure", "Sabina", "Orobica", "Atlas", "Nimbus", "Orbit", "Helix", "Vega", "Quasar", "Aurora", "Cometa", "Fenice", "Sirio"];

export interface Topic {
  keywords: [string, string, string];
  name: string;
}

export class SyntheticSpace {
  readonly topics: Topic[];
  readonly centroids: Float32Array[];
  private readonly noise: Float32Array;
  private readonly r: Rng;

  constructor(
    readonly dims: number,
    readonly nTopics: number,
    seed = 7,
    /** Norm of the noise added to the centroid: 0.75 gives cos(chunk, centroid) ≈ 0.8. */
    readonly noiseNorm = 0.75,
  ) {
    this.r = rng(seed);
    this.topics = Array.from({ length: nTopics }, () => ({
      keywords: [this.pick(KEYWORDS), this.pick(KEYWORDS), this.pick(KEYWORDS)],
      name: this.pick(NAMES),
    }));
    this.centroids = Array.from({ length: nTopics }, () => normalize(this.gaussianVector(dims)));
    // Noise pool: slices at random offsets give cheap, independent-enough noise vectors.
    this.noise = new Float32Array(1 << 21);
    const std = noiseNorm / Math.sqrt(dims);
    for (let i = 0; i < this.noise.length; i++) this.noise[i] = this.gauss() * std;
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!;
  }

  private gauss(): number {
    const u = 1 - this.r();
    const v = this.r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private gaussianVector(d: number): Float32Array {
    const v = new Float32Array(d);
    for (let i = 0; i < d; i++) v[i] = this.gauss();
    return v;
  }

  topicOf(): number {
    // Zipf-like popularity: some topics are much more common (like real company subjects).
    return Math.floor(this.nTopics * Math.pow(this.r(), 1.6));
  }

  vector(topic: number, out = new Float32Array(this.dims)): Float32Array {
    const c = this.centroids[topic]!;
    const off = Math.floor(this.r() * (this.noise.length - this.dims));
    for (let i = 0; i < this.dims; i++) out[i] = c[i]! + this.noise[off + i]!;
    return normalize(out);
  }

  /**
   * Optional long-tail vocabulary (pseudo-words with Zipf frequency): names, codes and
   * technical terms of a real archive. Without it every query matches a large share of the
   * chunks, which is the worst case for full-text ranking and not a realistic one.
   */
  private rare: string[] = [];
  withRareVocabulary(size = 100_000): this {
    const syl = ["ba", "ce", "di", "fo", "gu", "la", "me", "ni", "po", "ru", "sa", "te", "vi", "zo", "tra", "ste", "pri", "gno", "chi", "sco"];
    const seen = new Set<string>();
    while (this.rare.length < size) {
      const n = 2 + Math.floor(this.r() * 3);
      let w = "";
      for (let i = 0; i < n; i++) w += this.pick(syl);
      if (this.r() < 0.15) w += String(Math.floor(this.r() * 900) + 100);
      if (!seen.has(w)) {
        seen.add(w);
        this.rare.push(w);
      }
    }
    return this;
  }
  rareWord(): string {
    return this.rare[Math.floor(this.rare.length * Math.pow(this.r(), 3))]!;
  }

  text(topic: number, targetChars = 700): string {
    const t = this.topics[topic]!;
    const parts: string[] = [];
    if (this.rare.length) parts.push(`Riferimenti: ${this.rareWord()}, ${this.rareWord()}, ${this.rareWord()}, ${this.rareWord()}.`);
    let len = parts.join(" ").length;
    while (len < targetChars) {
      const kw = this.r() < 0.6 ? this.pick(t.keywords) : this.pick(KEYWORDS);
      const s = `${this.pick(SUBJECTS)} di ${t.name} ${this.pick(VERBS)} ${this.pick(OBJECTS)} per ${kw} ${this.pick(TAILS)}.`;
      parts.push(s);
      len += s.length + 1;
    }
    return parts.join(" ");
  }

  query(topic: number): { text: string; vector: Float32Array } {
    const t = this.topics[topic]!;
    return { text: `${t.keywords[0]} ${t.keywords[1]} ${t.name}`, vector: this.vector(topic) };
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

export const vecLiteral = (v: Float32Array) => `[${Array.from(v, (x) => x.toFixed(5)).join(",")}]`;

// ---------------------------------------------------------------------------
// PostgreSQL binary COPY encoder: (int4 vault_id, int8 id, text, halfvec)
// ---------------------------------------------------------------------------
export const COPY_HEADER = Buffer.concat([Buffer.from("PGCOPY\n\xff\r\n\0", "latin1"), Buffer.alloc(8)]);
export const COPY_TRAILER = Buffer.from([0xff, 0xff]);

export function encodeRow(vault: number, id: number, text: string, vec: Float32Array): Buffer {
  const textBuf = Buffer.from(text, "utf8");
  const vecLen = 4 + vec.length * 2;
  const size = 2 + (4 + 4) + (4 + 8) + (4 + textBuf.length) + (4 + vecLen);
  const b = Buffer.allocUnsafe(size);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  dv.setInt16(o, 4); o += 2;
  dv.setInt32(o, 4); o += 4;
  dv.setInt32(o, vault); o += 4;
  dv.setInt32(o, 8); o += 4;
  dv.setBigInt64(o, BigInt(id)); o += 8;
  dv.setInt32(o, textBuf.length); o += 4;
  textBuf.copy(b, o); o += textBuf.length;
  dv.setInt32(o, vecLen); o += 4;
  // pgvector halfvec_recv: int16 dim, int16 unused, dim x float16 (network order)
  dv.setInt16(o, vec.length); o += 2;
  dv.setInt16(o, 0); o += 2;
  for (let i = 0; i < vec.length; i++) {
    dv.setFloat16(o, vec[i]!);
    o += 2;
  }
  return b;
}
