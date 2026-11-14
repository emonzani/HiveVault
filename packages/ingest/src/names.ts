/**
 * Names of the pages of a vault, found in the text of a source before the model reads it (M5),
 * and the key that finds an existing page for a new title that only differs in its legal form or
 * in a generic word (M6).
 *
 * The matcher is a trie over the words of the normalized names (titles and aliases): one pass
 * over the words of the text finds every name, whatever the number of names. It is the
 * word-level form of Aho-Corasick: names are matched on whole words only, so "Orbit" does not
 * match inside "Orbital".
 */
import { normalizeTitle, PERSONAL } from "@cb/brain";
import type { Sql } from "@cb/db";
import { entityKey } from "@cb/hive";

/** Generic words of company names: "Salentina Costruzioni Group" is "Salentina Costruzioni". */
const GENERIC = /\b(group|gruppo|holding)\b/g;

/**
 * Key of an entity title for the duplicate check at write time: no legal form ("S.p.A.",
 * "srl"), and for companies no generic word. Null for other types and for keys too short to
 * be safe. Different numbers give different keys ("ETSI EN 319 522-1" and "-2").
 */
export function dedupKey(title: string, type: string): string | null {
  if (!type.startsWith("entity/")) return null;
  let k = entityKey(title);
  if (type === "entity/company") k = k.replace(GENERIC, " ").replace(/\s+/g, " ").trim();
  return k.length >= 4 ? k : null;
}

export interface NamedPage {
  id: string;
  title: string;
  type: string;
  personal: boolean;
}

interface Node {
  next: Map<string, Node>;
  pages: number[];
}

export class NameMatcher {
  private readonly root: Node = { next: new Map(), pages: [] };

  constructor(names: { name: string; page: number }[]) {
    for (const { name, page } of names) {
      const words = normalizeTitle(name).split(" ").filter(Boolean);
      if (!words.length) continue;
      let n = this.root;
      for (const w of words) {
        let c = n.next.get(w);
        if (!c) n.next.set(w, (c = { next: new Map(), pages: [] }));
        n = c;
      }
      if (!n.pages.includes(page)) n.pages.push(page);
    }
  }

  /** Indexes of the pages whose names the text writes, in order of first mention. */
  find(text: string): number[] {
    const words = normalizeTitle(text).split(" ").filter(Boolean);
    const out = new Set<number>();
    for (let i = 0; i < words.length; i++) {
      let n: Node | undefined = this.root;
      for (let j = i; j < words.length; j++) {
        n = n.next.get(words[j]!);
        if (!n) break;
        for (const p of n.pages) out.add(p);
      }
    }
    return [...out];
  }
}

/** The names of the editable pages of one vault, at one vault version. */
export class VaultNames {
  constructor(
    readonly version: number,
    readonly pages: NamedPage[],
    private readonly matcher: NameMatcher,
    private readonly keys: Map<string, number[]>,
  ) {}

  static async load(sql: Sql, vaultId: string): Promise<VaultNames> {
    const [v] = await sql<{ version: number }[]>`select version from vaults where id = ${vaultId}`;
    // hive pages, sources and the inbox are rebuilt by code: the compiler never writes them
    const rows = await sql<{ id: string; title: string; type: string; personal: boolean; alias: string }[]>`
      select p.id, p.title, p.type, p.classification = ${PERSONAL} as personal, a.alias_norm as alias
      from aliases a join pages p on p.id = a.page_id
      where a.vault_id = ${vaultId} and length(a.alias_norm) >= 4
        and split_part(p.type, '/', 1) <> 'source' and not (p.frontmatter ? 'hive_subject') and p.path not like '\\_inbox/%'
      order by p.importance desc, p.id`;
    const pages: NamedPage[] = [];
    const index = new Map<string, number>();
    const names: { name: string; page: number }[] = [];
    const keys = new Map<string, number[]>();
    for (const r of rows) {
      let i = index.get(r.id);
      if (i === undefined) {
        i = pages.push({ id: r.id, title: r.title, type: r.type, personal: r.personal }) - 1;
        index.set(r.id, i);
      }
      names.push({ name: r.alias, page: i });
      const k = dedupKey(r.alias, r.type);
      if (k) {
        const l = keys.get(k) ?? [];
        if (!l.includes(i)) l.push(i);
        keys.set(k, l);
      }
    }
    return new VaultNames(Number(v?.version ?? 0), pages, new NameMatcher(names), keys);
  }

  /** Pages named in the text, personal ones only for a personal source (and only them). */
  find(text: string, personal: boolean, limit = 40): NamedPage[] {
    return this.matcher
      .find(text)
      .map((i) => this.pages[i]!)
      .filter((p) => p.personal === personal)
      .slice(0, limit);
  }

  /** An existing page for a new title with the same key and the same type (M6). */
  similar(titles: string[], type: string, personal: boolean): NamedPage | null {
    for (const t of titles) {
      const k = dedupKey(t, type);
      if (!k) continue;
      for (const i of this.keys.get(k) ?? []) {
        const p = this.pages[i]!;
        if (p.personal === personal && p.type === type) return p;
      }
    }
    return null;
  }
}
