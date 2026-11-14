// One worker process for spike A. The runner kills it with SIGKILL at random moments.
import "../../packages/db/src/env.ts";
import { createDb } from "@cb/db";
import { TaskEngine } from "@cb/tasks";
import { SpikeJob } from "./job.ts";

const sql = createDb({ max: 12, application: "spike-a-worker" });
const engine = new TaskEngine(sql, { concurrency: 8, leaseMs: 1500, pollMs: 100 }).register(SpikeJob);
await engine.start();
process.send?.("ready");
process.on("SIGTERM", async () => {
  await engine.stop();
  await sql.end();
  process.exit(0);
});
