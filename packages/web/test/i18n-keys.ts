// Reads the translation keys from the source: every t("...") call with a string literal key.
// Used by the catalog test and to list the keys a new translation needs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CALL = /(?<![\w.$])t(?:Html)?\(\s*("(?:[^"\\]|\\.)*")/g;

export function collectKeys(srcDir: string): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "kitchen") walk(p); // design specimen page, Italian only
      } else if (/\.(svelte|ts)$/.test(e.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(CALL)) keys.add(JSON.parse(m[1]!) as string);
      }
    }
  };
  walk(srcDir);
  return keys;
}

/** Placeholder names of a text, sorted: "{n} pagine di {name}" → ["n", "name"]. */
export const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

// npx tsx test/i18n-keys.ts <out.json>: writes the sorted key list
if (process.argv[1]?.endsWith("i18n-keys.ts") && process.argv[2]) {
  const { writeFileSync } = await import("node:fs");
  const keys = [...collectKeys(join(import.meta.dirname, "..", "src"))].sort();
  writeFileSync(process.argv[2], JSON.stringify(keys, null, 1));
  console.log(keys.length, "keys");
}
