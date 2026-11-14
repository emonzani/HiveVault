/**
 * Spike A — durable task engine under real crashes.
 *
 * Submits N tasks, runs W worker processes and kills one with SIGKILL every K ms
 * (then starts a new one). At the end it checks:
 *  - every task is done, with the checkpoint state intact;
 *  - every database effect ran exactly once (no duplicates, nothing lost);
 *  - recovery time after a kill (lease expiry) and total throughput.
 *
 * Usage: npm run spike:a -- [tasks=300] [workers=3] [killEveryMs=700]
 */
import "../../packages/db/src/env.ts";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, migrate } from "@cb/db";
import { submitTask } from "@cb/tasks";
import { ulid } from "@cb/shared";
import { SpikeJob } from "./job.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const [N = 300, W = 3, KILL_MS = 700] = process.argv.slice(2).map(Number);
const run = `a-${ulid().slice(-8)}`;
const sql = createDb({ max: 4, application: "spike-a-runner" });
await migrate(sql);
await sql`create table if not exists spike_a_effects (run text, task_id text, effect text, at timestamptz default now())`;

console.log(`Spike A ${run}: ${N} tasks, ${W} workers, one SIGKILL every ${KILL_MS} ms`);
const ids: string[] = [];
for (let i = 0; i < N; i++) ids.push((await submitTask(sql, SpikeJob, { run, n: i }, { requestId: `${run}:${i}` })).id);

const workers = new Set<ChildProcess>();
let kills = 0;
function startWorker(): void {
  const child = fork(path.join(here, "worker.ts"), { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  workers.add(child);
  child.on("exit", () => workers.delete(child));
}
for (let i = 0; i < W; i++) startWorker();

const t0 = Date.now();
const killer = setInterval(() => {
  const list = [...workers];
  const victim = list[Math.floor(Math.random() * list.length)];
  if (!victim) return;
  victim.kill("SIGKILL");
  kills++;
  startWorker();
}, KILL_MS);

const doneCount = async () =>
  ((await sql`select count(*)::int as n from tasks where id = any(${ids}) and status in ('done','failed','cancelled')`)[0] as { n: number }).n;
let last = -1;
for (;;) {
  const d = await doneCount();
  if (d !== last) {
    process.stdout.write(`\r  finished ${d}/${N}  kills ${kills}   `);
    last = d;
  }
  if (d === N) break;
  if (Date.now() - t0 > 10 * 60 * 1000) throw new Error("timeout");
  await new Promise((r) => setTimeout(r, 250));
}
clearInterval(killer);
const elapsed = (Date.now() - t0) / 1000;
for (const w of workers) w.kill("SIGTERM");
console.log();

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
const statuses = await sql<{ status: string; n: number }[]>`
  select status, count(*)::int as n from tasks where id = any(${ids}) group by status`;
const effects = await sql<{ effect: string; copies: number; tasks: number }[]>`
  select effect, copies, count(*)::int as tasks from (
    select task_id, effect, count(*)::int as copies from spike_a_effects where run = ${run} group by task_id, effect
  ) x group by effect, copies order by effect, copies`;
const missing = await sql<{ effect: string; n: number }[]>`
  select e.effect, count(*)::int as n
  from unnest(${ids}::text[]) as t(id) cross join (values ('p1'), ('p3')) as e(effect)
  where not exists (select 1 from spike_a_effects s where s.run = ${run} and s.task_id = t.id and s.effect = e.effect)
  group by e.effect`;
const recov = await sql<{ n: number; p50: number; p95: number; max: number }[]>`
  with exp as (
    select ev.task_id, ev.at from task_events ev where ev.kind = 'lease_expired' and ev.task_id = any(${ids})
  ), nxt as (
    select exp.task_id, extract(epoch from (min(c.at) - exp.at)) * 1000 as ms
    from exp join task_events c on c.task_id = exp.task_id and c.kind = 'claimed' and c.at > exp.at
    group by exp.task_id, exp.at
  )
  select count(*)::int as n,
         coalesce(percentile_cont(0.5) within group (order by ms), 0)::float as p50,
         coalesce(percentile_cont(0.95) within group (order by ms), 0)::float as p95,
         coalesce(max(ms), 0)::float as max
  from nxt`;
const replays = await sql<{ n: number }[]>`
  select count(*)::int as n from task_events where task_id = any(${ids}) and kind = 'claimed' and (data->>'attempt')::int > 1`;
const effRows = await sql<{ n: number }[]>`select count(*)::int as n from task_effects where task_id = any(${ids})`;

const allDone = statuses.length === 1 && statuses[0]!.status === "done";
const dup = effects.filter((e) => e.copies > 1);
const ok = allDone && dup.length === 0 && missing.length === 0;

const report = `# Spike A — task engine under crashes

Run \`${run}\` · ${new Date().toISOString()} · ${N} tasks × 4 phases · ${W} worker processes · SIGKILL every ${KILL_MS} ms

| Check | Result |
|---|---|
| Tasks by status | ${statuses.map((s) => `${s.status}: ${s.n}`).join(", ")} |
| Worker processes killed (SIGKILL) | ${kills} |
| Database effects: copies per task | ${effects.map((e) => `${e.effect}×${e.copies}: ${e.tasks} tasks`).join(", ")} |
| Duplicate database effects | ${dup.length === 0 ? "none" : JSON.stringify(dup)} |
| Missing database effects | ${missing.length === 0 ? "none" : JSON.stringify(missing)} |
| Tasks recovered after an expired lease | ${recov[0]!.n} |
| Delay from lease expiry to the new claim (lease 1.5 s; detection adds up to the lease time) | p50 ${recov[0]!.p50.toFixed(0)} ms · p95 ${recov[0]!.p95.toFixed(0)} ms · max ${recov[0]!.max.toFixed(0)} ms |
| Claims that resumed an interrupted phase | ${replays[0]!.n} |
| Journaled effects | ${effRows[0]!.n} |
| Total time | ${elapsed.toFixed(1)} s (${(N / elapsed).toFixed(1)} tasks/s with the kills) |

**Result: ${ok ? "PASS" : "FAIL"}** — ${ok ? "every task finished, every database effect ran exactly once." : "see the rows above."}
`;
await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
await writeFile(path.resolve(here, "../../docs/spikes/spike-a.md"), report);
console.log(report);
await sql.end();
process.exit(ok ? 0 : 1);
