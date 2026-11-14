import "./env.ts";
import { createDb, migrate } from "./index.ts";

const cmd = process.argv[2];
const sql = createDb({ max: 1, application: "cb-migrate" });
try {
  if (cmd === "migrate") {
    const r = await migrate(sql);
    console.log(`Migrations applied: ${r.applied.length ? r.applied.join(", ") : "none"} (already applied: ${r.skipped.length})`);
  } else {
    console.error("Usage: tsx packages/db/src/cli.ts migrate");
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
