/**
 * Input of the load test (phase 8): an API account with read access to every vault and no rate
 * limit to speak of, page ids and search queries taken from the database. Writes
 * bench/out/load-seed.json (the key is in it: bench/out is not committed). `--clean` removes the
 * account.
 *
 * Usage: npx tsx bench/phase8/load-seed.ts [--clean]
 */
import "../../packages/db/src/env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { AuthService } from "@cb/auth";
import { loadMasterKey } from "@cb/blobs";
import { createDb } from "@cb/db";
import { loadServerConfig } from "../../packages/server/src/config.ts";

const NAME = "bench-load";
const cfg = loadServerConfig();
const sql = createDb({ max: 2, application: "cb-load-seed" });
const auth = new AuthService(sql, { masterKey: loadMasterKey(cfg.dataDir), webauthn: { rpId: cfg.rpId, rpName: "HiveVault", origins: [cfg.publicUrl] } });

await sql`delete from principals where name = ${NAME}`;
if (!process.argv.includes("--clean")) {
  const p = await auth.principals.createApiAccount({ name: NAME, displayName: "Test di carico (fase 8)", scopes: ["read"], clearance: 1, ratePerMin: 1_000_000, createdBy: null });
  const vaults = await sql<{ id: string }[]>`select id from vaults`;
  for (const v of vaults) await auth.access.grant(p.id, v.id, "read", null);
  const key = await auth.apiKeys.issue(p.id, "carico", null);
  // pages the account may read (clearance "interno"), and real words of their titles as queries
  const pages = await sql<{ id: string; title: string }[]>`
    select id, title from pages where classification <= 1 and tokens > 80 order by random() limit 400`;
  const words = [...new Set(pages.flatMap((x) => x.title.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4))];
  const queries = Array.from({ length: 300 }, (_, i) => `${words[i % words.length]} ${words[(i * 7 + 3) % words.length]}`.trim()).concat(["stato del cliente", "contratto rinnovo", "responsabile tecnico", "postazioni", "decisione fornitore"]);
  mkdirSync("bench/out", { recursive: true });
  writeFileSync("bench/out/load-seed.json", JSON.stringify({ key: key.key, pages: pages.map((x) => x.id), queries, nonce: randomBytes(4).toString("hex") }));
  console.log(`account ${NAME}: ${vaults.length} vault, ${pages.length} pagine, ${queries.length} query → bench/out/load-seed.json`);
}
await auth.stop();
await sql.end();
