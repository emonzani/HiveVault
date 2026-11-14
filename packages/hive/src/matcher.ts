/**
 * Aho-Corasick over the names of the link targets (M11). The crosslink used to build one
 * regular expression with every name of the vault for every page: its cost grew as pages ×
 * names. The automaton is built once per pass and finds every name in one scan of a page.
 *
 * Matching is on lower-case text, at the same positions as the original: `lower` returns null
 * for a text whose lower case has another length (a few Unicode letters), and the caller then
 * uses the regular expression.
 */

interface Node {
  next: Map<string, number>;
  fail: number;
  /** Patterns that end here (indexes), the longest first. */
  out: number[];
}

export interface Match {
  start: number;
  /** Index of the pattern. */
  pattern: number;
  length: number;
}

export class NameAutomaton {
  private readonly nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];
  readonly lengths: number[];

  constructor(patterns: string[]) {
    this.lengths = patterns.map((p) => p.length);
    patterns.forEach((p, i) => {
      let n = 0;
      // UTF-16 units, as the scan of the text: the positions stay the positions of the string
      const lp = p.toLowerCase();
      for (let k = 0; k < lp.length; k++) {
        const ch = lp[k]!;
        let c = this.nodes[n]!.next.get(ch);
        if (c === undefined) {
          c = this.nodes.push({ next: new Map(), fail: 0, out: [] }) - 1;
          this.nodes[n]!.next.set(ch, c);
        }
        n = c;
      }
      this.nodes[n]!.out.push(i);
    });
    // failure links, breadth first; outputs of the failure node join the node's own
    const queue: number[] = [];
    for (const c of this.nodes[0]!.next.values()) queue.push(c);
    for (let h = 0; h < queue.length; h++) {
      const n = queue[h]!;
      for (const [ch, c] of this.nodes[n]!.next) {
        let f = this.nodes[n]!.fail;
        while (f && !this.nodes[f]!.next.has(ch)) f = this.nodes[f]!.fail;
        const g = this.nodes[f]!.next.get(ch);
        this.nodes[c]!.fail = g !== undefined && g !== c ? g : 0;
        this.nodes[c]!.out.push(...this.nodes[this.nodes[c]!.fail]!.out);
        queue.push(c);
      }
    }
    for (const n of this.nodes) n.out.sort((a, b) => this.lengths[b]! - this.lengths[a]!);
  }

  /** Lower case of `text` with the same length, or null. */
  static lower(text: string): string | null {
    const l = text.toLowerCase();
    return l.length === text.length ? l : null;
  }

  /** Every occurrence of every pattern in a lower-case text (overlapping ones too). */
  all(lowerText: string): Match[] {
    const out: Match[] = [];
    let n = 0;
    for (let i = 0; i < lowerText.length; i++) {
      const ch = lowerText[i]!;
      while (n && !this.nodes[n]!.next.has(ch)) n = this.nodes[n]!.fail;
      n = this.nodes[n]!.next.get(ch) ?? 0;
      for (const p of this.nodes[n]!.out) out.push({ start: i + 1 - this.lengths[p]!, pattern: p, length: this.lengths[p]! });
    }
    return out;
  }
}
