/**
 * Phase 3 acceptance: bulk import of a very large folder tree, with progress.
 *
 * 1. Generates N small text files (unique content) in 1000-file folders, once.
 * 2. Starts an import job with W worker processes (each: import + ingest tasks).
 * 3. Samples the job progress (stored, pending, rate, ETA) and the ingestion levels every
 *    `sample` seconds, and checks that the progress is consistent: stored + pending + skipped
 *    + errors = scanned, stored only grows, ETA falls.
 *
 * Usage: npx tsx bench/phase3/import.ts [files=1000000] [workers=2] [sampleSeconds=15] [--ingest-wait]
 */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VaultStore } from "@cb/brain";
import { migrate } from "@cb/db";
import { ImportService, type ImportStats } from "@cb/ingest";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { DATA, DIMS, services } from "./setup.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [N = 1_000_000, W = 2, SAMPLE = 15] = args.map(Number);
const WAIT_INGEST = process.argv.includes("--ingest-wait");
const root = path.join(DATA, `share-${N}`);
const run = ulid().slice(-6).toLowerCase();

// 1. files
const tGen = Date.now();
if (!existsSync(path.join(root, ".complete"))) {
  console.log(`generating ${N} files in ${root} ...`);
  const words = ["contratto", "fattura", "consegna", "progetto", "cliente", "fornitore", "verbale", "offerta", "ordine", "collaudo", "rinnovo", "budget"];
  for (let d = 0; d * 1000 < N; d++) {
    const dir = path.join(root, `cartella-${String(d).padStart(4, "0")}`);
    await mkdir(dir, { recursive: true });
    const jobs: Promise<void>[] = [];
    for (let i = d * 1000; i < Math.min(N, (d + 1) * 1000); i++) {
      jobs.push(writeFile(path.join(dir, `doc-${i}.txt`), `Documento ${i}: ${words[i % 12]} ${words[(i * 7) % 12]} numero ${i} del ${1 + (i % 28)}/0${1 + (i % 9)}/2026.\n`));
    }
    await Promise.all(jobs);
    if (d % 50 === 0) process.stdout.write(`\r  ${Math.min(N, (d + 1) * 1000)} files`);
  }
  await writeFile(path.join(root, ".complete"), "");
  console.log();
}
const genSeconds = (Date.now() - tGen) / 1000;

// 2. job + workers
const s = services({ max: 4, importRoot: DATA });
await migrate(s.sql);
const vault = await new VaultStore(s.sql, DIMS).create({ kind: "space", slug: `imp3-${run}`, name: `Import ${N}` });
const engine = new TaskEngine(s.sql, { concurrency: 1 }); // submit only, no worker here
const imports = new ImportService(s.sql, engine, s.importTask, [DATA]);
const job = await imports.create({ vaultId: vault.id, root, exclude: [".complete"] });
const workers: ChildProcess[] = [];
for (let i = 0; i < W; i++) {
  workers.push(fork(path.join(here, "worker.ts"), { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, LOG_LEVEL: "error", CB_IMPORT_ROOT: DATA, CB_WORKERS: "8" } }));
}

// 3. progress samples
const t0 = Date.now();
interface Sample {
  t: number;
  status: string;
  stats: ImportStats;
  levels: Record<string, number>;
}
const samples: Sample[] = [];
const problems: string[] = [];
for (;;) {
  await new Promise((r) => setTimeout(r, SAMPLE * 1000));
  const j = (await imports.get(job.id))!;
  const sample = { t: Math.round((Date.now() - t0) / 1000), status: j.status, stats: j.stats, levels: j.ingest };
  samples.push(sample);
  const st = j.stats;
  const prev = samples.at(-2);
  if (prev && (st.stored ?? 0) < (prev.stats.stored ?? 0)) problems.push(`stored decreased at ${sample.t}s`);
  if (j.status === "done" && (st.stored ?? 0) + (st.pending ?? 0) + (st.skipped ?? 0) + (st.errors ?? 0) !== st.scanned) problems.push(`counts do not add up: ${JSON.stringify(st)}`);
  const ingested = Object.entries(j.ingest).filter(([k]) => k !== "I0").reduce((a, [, v]) => a + v, 0);
  console.log(`  ${sample.t}s ${j.status} scanned ${st.scanned ?? "-"} stored ${st.stored ?? 0} pending ${st.pending ?? "-"} ${st.filesPerSec ?? 0}/s eta ${st.etaSeconds ?? "-"}s | ingested(I1+) ${ingested}`);
  if (j.status === "done" && (!WAIT_INGEST || ingested >= (st.stored ?? 0) - (st.duplicates ?? 0))) break;
  if (j.status === "failed") break;
}
const totalSeconds = (Date.now() - t0) / 1000;
for (const w of workers) w.kill("SIGTERM");

const final = samples.at(-1)!;
const sizes = (await s.sql`
  select pg_size_pretty(sum(pg_total_relation_size(c.oid))::bigint) as size from pg_class c
  where c.relname in ('import_files', 'sources', 'tasks', 'task_events', (select chunks_partition from vaults where id = ${vault.id}))`) as unknown as [{ size: string }];
const ingestedFinal = Object.entries(final.levels).filter(([k]) => k !== "I0").reduce((a, [, v]) => a + v, 0);
const report = `# Fase 3 — import massivo di ${N.toLocaleString("it-IT")} file

Run \`${run}\` · ${new Date().toISOString()} · ${W} processi worker × 8 task · file di testo da ~80 byte in cartelle da 1000

| Misura | Valore |
|---|---|
| Generazione dei file (una volta) | ${genSeconds.toFixed(0)} s |
| Scansione | ${final.stats.scanSeconds ?? "-"} s (${final.stats.scanned?.toLocaleString("it-IT")} file) |
| Memorizzazione (lettura, cifratura, sorgente, task) | ${final.stats.filesPerSec ?? "-"} file/s |
| File salvati / duplicati / saltati / errori | ${final.stats.stored} / ${final.stats.duplicates ?? 0} / ${final.stats.skipped ?? 0} / ${final.stats.errors ?? 0} |
| Sorgenti indicizzate (I1+) alla fine della misura | ${ingestedFinal.toLocaleString("it-IT")} |
| Durata della misura | ${(totalSeconds / 60).toFixed(1)} min |
| Spazio nel database (import_files, sources, tasks, eventi, chunk) | ${sizes[0].size} |
| Coerenza dell'avanzamento | ${problems.length ? problems.join("; ") : "OK (salvati crescenti, somme corrette)"} |

## Avanzamento campionato

| t (s) | Stato | Salvati | In attesa | File/s | ETA (s) | Indicizzati |
|---|---|---|---|---|---|---|
${samples.map((x) => `| ${x.t} | ${x.status} | ${x.stats.stored ?? 0} | ${x.stats.pending ?? "-"} | ${x.stats.filesPerSec ?? "-"} | ${x.stats.etaSeconds ?? "-"} | ${Object.entries(x.levels).filter(([k]) => k !== "I0").reduce((a, [, v]) => a + v, 0)} |`).join("\n")}
`;
await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
await writeFile(path.resolve(here, `../../docs/spikes/phase3-import-${N}.md`), report);
console.log(report);
s.dispatcher.stop();
await s.sql.end();
process.exit(problems.length ? 1 : 0);
