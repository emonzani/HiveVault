/**
 * Database backup with pgBackRest (phase 8), through the `postgres` service of docker compose.
 *
 *   npm run backup -- stanza    creates the stanza (once, on an existing data volume)
 *   npm run backup -- full      full backup          (weekly: see docs/guide/operatore.md)
 *   npm run backup -- diff      differential backup  (daily)
 *   npm run backup -- info      backups and WAL in the repository
 *   npm run backup -- verify    restore test: point-in-time restore of the latest backup into a
 *                               temporary container, checks of the restored data, cleanup
 *
 * `verify` writes two marker rows: one before the target time (it must come back) and one
 * after (it must not). It touches only a temporary container and a temporary volume.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [cmd = "info"] = process.argv.slice(2);
const sh = (args: string[], o: { input?: string; quiet?: boolean } = {}) => {
  const r = spawnSync("docker", args, { encoding: "utf8", input: o.input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 4).join(" ")}… non riuscito:\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
  if (!o.quiet) process.stdout.write(r.stdout);
  return r.stdout;
};
const pgbr = (...args: string[]) => sh(["compose", "exec", "-T", "-u", "postgres", "postgres", "pgbackrest", "--stanza=brain", ...args]);
const psql = (sql: string, db = "brain") => sh(["compose", "exec", "-T", "postgres", "psql", "-U", "brain", "-d", db, "-AtX", "-v", "ON_ERROR_STOP=1", "-c", sql], { quiet: true }).trim();

async function verify(): Promise<void> {
  const t0 = Date.now();
  const run = Date.now().toString(36);
  // 1. reference state and the first marker, then a fresh differential backup
  psql(`create table if not exists backup_check (run text, n int, at timestamptz default now())`);
  psql(`insert into backup_check (run, n) values ('${run}', 1)`);
  const counts = (q: (sql: string) => string) =>
    Object.fromEntries(["principals", "vaults", "pages", "page_versions", "sources", "audit_log", "metric_series"].map((t) => [t, Number(q(`select count(*) from ${t}`))]));
  pgbr("--type=diff", "backup");
  // 2. the target time; the second marker is written after it and must not come back
  psql(`select pg_switch_wal()`);
  const target = psql(`select to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US+00') from (select pg_sleep(1.1)) s`);
  const before = counts(psql);
  execFileSync("node", ["-e", "setTimeout(()=>{},1200)"]);
  psql(`insert into backup_check (run, n) values ('${run}', 2)`);
  psql(`select pg_switch_wal()`);
  pgbr("check"); // waits until the WAL with the second marker is archived

  // 3. restore into a temporary volume and container (same image, repository read through the volume)
  const name = `cb-restore-${run}`;
  const vol = `cb-restore-${run}`;
  const project = sh(["compose", "config", "--format", "json"], { quiet: true });
  const repoVolume = (JSON.parse(project) as { name: string }).name + "_pgbackrest";
  const pass = sh(["compose", "exec", "-T", "postgres", "printenv", "PGBACKREST_REPO1_CIPHER_PASS"], { quiet: true }).trim();
  try {
    sh(["volume", "create", vol], { quiet: true });
    const restoreArgs = ["run", "--rm", "-u", "postgres", "-e", `PGBACKREST_REPO1_CIPHER_PASS=${pass}`, "-v", `${repoVolume}:/var/lib/pgbackrest`, "-v", `${vol}:/var/lib/postgresql/data`, "hivevault/postgres:17"];
    const tr = Date.now();
    sh([...restoreArgs, "pgbackrest", "--stanza=brain", "--type=time", `--target=${target}`, "--target-action=promote", "--archive-mode=off", "restore"], { quiet: true });
    const restoreS = (Date.now() - tr) / 1000;
    // Recovery refuses settings lower than the primary's: copy them (a real restore needs the same)
    const MUST_MATCH = ["max_connections", "max_locks_per_transaction", "max_prepared_transactions", "max_worker_processes", "max_wal_senders"];
    const settings = psql(`select string_agg(name || '=' || setting, ' ') from pg_settings where name = any('{${MUST_MATCH.join(",")}}')`).split(" ").flatMap((x) => ["-c", x]);
    // recovery replays WAL with `pgbackrest archive-get`: it needs the repository and its passphrase
    sh(["run", "-d", "--name", name, "-u", "postgres", "-e", `PGBACKREST_REPO1_CIPHER_PASS=${pass}`, "-v", `${repoVolume}:/var/lib/pgbackrest:ro`, "-v", `${vol}:/var/lib/postgresql/data`, "hivevault/postgres:17", "postgres", "-c", "archive_mode=off", "-c", "shared_buffers=1GB", ...settings], { quiet: true });
    // wait for recovery to finish and the server to accept connections
    const q = (sql: string) => sh(["exec", name, "psql", "-U", "brain", "-d", "brain", "-AtX", "-c", sql], { quiet: true }).trim();
    let ready = false;
    for (let i = 0; i < 600 && !ready; i++) {
      try {
        ready = q("select not pg_is_in_recovery()") === "t";
      } catch {
        /* still starting */
      }
      if (ready) break;
      // a failed recovery stops the container: report its log at once
      if (sh(["inspect", "-f", "{{.State.Running}}", name], { quiet: true }).trim() !== "true") {
        const log = spawnSync("docker", ["logs", "--tail", "15", name], { encoding: "utf8" });
        throw new Error(`il database ripristinato si è fermato durante il recupero:\n${(log.stdout + log.stderr).trim()}`);
      }
      execFileSync("node", ["-e", "setTimeout(()=>{},1000)"]);
    }
    if (!ready) throw new Error("il database ripristinato non si è avviato in 10 minuti");
    const markers = q(`select string_agg(n::text, ',' order by n) from backup_check where run = '${run}'`);
    const after = counts(q);
    const integrity = q(`select count(*) from pages p where not exists (select 1 from vaults v where v.id = p.vault_id)`);
    const vectorRows = q(`select count(*) from chunks where embedding is not null`);
    const ok = markers === "1" && JSON.stringify(after) === JSON.stringify(before) && integrity === "0";
    const report = { ok, run, target, restoreSeconds: restoreS, totalSeconds: (Date.now() - t0) / 1000, markers, expectedMarkers: "1", counts: { before, after }, orphanPages: Number(integrity), vectorRows: Number(vectorRows) };
    mkdirSync("bench/out", { recursive: true });
    writeFileSync(`bench/out/backup-verify-${run}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!ok) throw new Error("VERIFICA NON RIUSCITA: il ripristino non corrisponde allo stato al momento scelto");
    console.log(`\nRipristino verificato: stato al ${target}, ${restoreS.toFixed(0)} s di restore.`);
  } finally {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    spawnSync("docker", ["volume", "rm", "-f", vol], { encoding: "utf8" });
    psql(`delete from backup_check where run = '${run}'`);
  }
}

switch (cmd) {
  case "stanza":
    pgbr("stanza-create");
    pgbr("check");
    break;
  case "full":
  case "diff":
  case "incr":
    pgbr(`--type=${cmd}`, "backup");
    pgbr("info");
    break;
  case "info":
    pgbr("info");
    break;
  case "check":
    pgbr("check");
    break;
  case "verify":
    await verify();
    break;
  default:
    console.error(`Comando sconosciuto: ${cmd}. Usa stanza, full, diff, info, check o verify.`);
    process.exit(2);
}
