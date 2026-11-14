/**
 * Development only: an administrator "admin" for the console and the dashboards, with TOTP.
 * The secret goes to data/dev-admin.json (data/ is not committed); running the script again
 * keeps the account and prints the current code.
 *
 * Usage: npx tsx scripts/dev-admin.ts
 */
import "../packages/db/src/env.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuthService, base32Decode, totp } from "@cb/auth";
import { loadMasterKey } from "@cb/blobs";
import { createDb, migrate } from "@cb/db";
import { loadServerConfig } from "../packages/server/src/config.ts";

const cfg = loadServerConfig();
const file = path.join(cfg.dataDir, "dev-admin.json");
const sql = createDb({ max: 2, application: "cb-dev-admin" });
await migrate(sql);
const auth = new AuthService(sql, { masterKey: loadMasterKey(cfg.dataDir), webauthn: { rpId: cfg.rpId, rpName: "HiveVault", origins: [cfg.publicUrl] } });

let secret = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { secret: string }).secret : "";
const [exists] = await sql`select id from principals where name = 'admin' and kind = 'user'`;
if (!exists || !secret) {
  if (exists) await sql`delete from principals where id = ${exists.id}`;
  const p = await auth.principals.createUser({ username: "admin", displayName: "Amministratore (sviluppo)", role: "admin", clearance: 3 });
  const { code } = await auth.totp.createEnrollment(p.id, null);
  const st = await auth.totp.startEnrollment(code);
  await auth.enrollConfirm(code, totp(base32Decode(st.secretBase32)), { userAgent: "dev-admin" });
  secret = st.secretBase32;
  writeFileSync(file, JSON.stringify({ username: "admin", secret }, null, 2));
}
console.log(`admin: ${totp(base32Decode(secret))} (valido ancora ${30 - (Math.floor(Date.now() / 1000) % 30)} s) · segreto in ${file}`);
await auth.stop();
await sql.end();
