// One worker process of the phase 3 runs. The crash runner kills it with SIGKILL.
import { TaskEngine } from "@cb/tasks";
import { services } from "./setup.ts";

const s = services({ importRoot: process.env.CB_IMPORT_ROOT ?? undefined });
const engine = new TaskEngine(s.sql, { concurrency: Number(process.env.CB_WORKERS ?? 6), leaseMs: 2000, pollMs: 100 }).register(s.ingestTask, s.importTask);
await engine.start();
process.send?.("ready");
process.on("SIGTERM", async () => {
  await engine.stop();
  s.dispatcher.stop();
  await s.sql.end();
  process.exit(0);
});
