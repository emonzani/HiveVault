// Starts the dream cycle of a vault now, through the running server (development): npx tsx scripts/dream-now.ts <vault slug>
import "../packages/db/src/env.ts"; // .env first: the model settings are read when the services start
import { createDb } from "@cb/db";
import { defineDreamTask, nightOf } from "@cb/hive";
import { submitTask } from "@cb/tasks";
const sql = createDb();
const slug = process.argv[2] ?? "demo-cella";
const [v] = await sql<{ id: string }[]>`select id from vaults where slug = ${slug}`;
const night = nightOf(new Date(), process.env.DREAM_WINDOW ?? "22:00-06:00");
await sql`delete from dream_runs where vault_id = ${v!.id} and night = ${night}`;
const def = defineDreamTask({ sql, pages: null as never });
const t = await submitTask(sql, def, { vaultId: v!.id, night, manual: true }, { requestId: `dream:${v!.id}:manual:${Date.now()}`, priority: 2 });
console.log(t.id, night);
await sql.end();
