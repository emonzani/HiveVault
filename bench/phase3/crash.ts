/**
 * Phase 3 acceptance: kill the workers while they compile, then check that nothing is lost
 * and nothing is duplicated.
 *
 * N sources (Markdown, some with an attached ZIP) are uploaded with compile = true. Worker
 * processes run the full pipeline (parse, index, embed, compile with a slow scripted model).
 * One worker is killed with SIGKILL every K ms and replaced. At the end:
 *   - every source (and every child) is compiled (level 3) with exactly one source page;
 *   - every per-source entity page exists once; the page shared by all sources exists once;
 *   - chunks per source match the chunker output; no task failed.
 *
 * Usage: npx tsx bench/phase3/crash.ts [sources=60] [workers=2] [killEveryMs=1500]
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { VaultStore } from "@cb/brain";
import { migrate } from "@cb/db";
import { ulid } from "@cb/shared";
import { submitTask } from "@cb/tasks";
import { DIMS, services } from "./setup.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const [N = 60, W = 2, KILL_MS = 1500] = process.argv.slice(2).map(Number);
const run = ulid().slice(-6).toLowerCase();
const s = services({ max: 4 });
await migrate(s.sql);
const vault = await new VaultStore(s.sql, DIMS).create({ kind: "space", slug: `crash3-${run}`, name: "Crash fase 3" });

console.log(`Phase 3 crash run ${run}: ${N} sources, ${W} workers, SIGKILL every ${KILL_MS} ms`);
const ids: string[] = [];
for (let i = 0; i < N; i++) {
  let data: Buffer;
  let name: string;
  if (i % 5 === 0) {
    const zip = new JSZip();
    zip.file(`allegato-${i}.md`, `# Allegato ${i} ${run}\n\nContenuto dell'allegato ${i}.`);
    data = await zip.generateAsync({ type: "nodebuffer" });
    name = `pacchetto-${i}.zip`;
  } else {
    data = Buffer.from(`# Documento ${i} ${run}\n\n${"Paragrafo del documento con dettagli. ".repeat(20)}\n\n## Seconda parte\n\nAltro testo ${i}.`);
    name = `documento-${i}.md`;
  }
  const { source } = await s.store.create(data, { vaultId: vault.id, name, origin: "upload", compile: true, priority: 1 });
  const t = await submitTask(s.sql, s.ingestTask, { sourceId: source.id }, { requestId: `ingest:${source.id}:${source.sha256}`, priority: 1 });
  await s.sql`update sources set task_id = ${t.id} where id = ${source.id}`;
  ids.push(source.id);
}

const workers = new Set<ChildProcess>();
let kills = 0;
const startWorker = () => {
  const c = fork(path.join(here, "worker.ts"), { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, LOG_LEVEL: "error" } });
  workers.add(c);
  c.on("exit", () => workers.delete(c));
};
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

const open = async () =>
  ((await s.sql`
    select count(*)::int as n from sources s left join tasks t on t.id = s.task_id
    where s.vault_id = ${vault.id} and (t.id is null or t.status not in ('done', 'failed', 'cancelled'))`)[0] as { n: number }).n;
for (;;) {
  const n = await open();
  process.stdout.write(`\r  open sources ${n}  kills ${kills}   `);
  if (n === 0) break;
  if (Date.now() - t0 > 15 * 60_000) throw new Error("timeout");
  await new Promise((r) => setTimeout(r, 500));
}
clearInterval(killer);
const seconds = (Date.now() - t0) / 1000;
for (const w of workers) w.kill("SIGTERM");
console.log();

// ---------------------------------------------------------------------------
const q = async <T>(p: PromiseLike<unknown>) => (await p) as T;
const sources = await q<{ id: string; level: number; status: string; compiled_page: string | null; parent_id: string | null }[]>(
  s.sql`select id, level, status, compiled_page, parent_id from sources where vault_id = ${vault.id}`,
);
const srcPages = await q<{ source: string; n: number }[]>(
  s.sql`select frontmatter->>'source' as source, count(*)::int as n from pages where vault_id = ${vault.id} and type = 'source' group by 1`,
);
const entities = await q<{ title: string; n: number }[]>(
  s.sql`select title, count(*)::int as n from pages where vault_id = ${vault.id} and type like 'entity%' group by title`,
);
const failedTasks = await q<{ n: number }[]>(
  s.sql`select count(*)::int as n from tasks t join sources s on s.task_id = t.id where s.vault_id = ${vault.id} and t.status <> 'done'`,
);
const recovered = await q<{ n: number }[]>(
  s.sql`select count(*)::int as n from task_events e join sources s on s.task_id = e.task_id where s.vault_id = ${vault.id} and e.kind = 'lease_expired'`,
);
const turns = await q<{ n: number }[]>(s.sql`select count(*)::int as n from page_versions v join pages p on p.id = v.page_id where p.vault_id = ${vault.id} and p.title = 'Cliente comune'`);

const children = sources.filter((x) => x.parent_id).length;
const notCompiled = sources.filter((x) => x.level !== 3 || x.status !== "compiled" || !x.compiled_page);
const dupSourcePages = srcPages.filter((p) => p.n !== 1);
const missingSourcePages = sources.filter((x) => !srcPages.some((p) => p.source === x.id));
const dupEntities = entities.filter((e) => e.n !== 1);
const perSource = entities.filter((e) => e.title.startsWith("Entità ")).length;
const shared = entities.find((e) => e.title === "Cliente comune")?.n ?? 0;
const ok = notCompiled.length === 0 && dupSourcePages.length === 0 && missingSourcePages.length === 0 && dupEntities.length === 0 && perSource === sources.length && shared === 1 && failedTasks[0]!.n === 0;

const report = `# Fase 3 — compilazione con crash dei worker

Run \`${run}\` · ${new Date().toISOString()} · ${N} sorgenti caricate (${children} figli da ZIP) · ${W} processi worker · SIGKILL ogni ${KILL_MS} ms · modello a copione lento (150 ms per turno, 4 turni per sorgente)

| Controllo | Risultato |
|---|---|
| Sorgenti (con i figli) | ${sources.length} |
| Processi worker uccisi | ${kills} |
| Task ripresi dopo la scadenza del lease | ${recovered[0]!.n} |
| Sorgenti non compilate | ${notCompiled.length === 0 ? "nessuna" : notCompiled.length} |
| Pagine sorgente: mancanti / duplicate | ${missingSourcePages.length} / ${dupSourcePages.length} |
| Pagine di entità per sorgente (attese ${sources.length}) | ${perSource} |
| Pagine con titolo duplicato | ${dupEntities.length === 0 ? "nessuna" : JSON.stringify(dupEntities)} |
| Pagina condivisa "Cliente comune": copie / versioni | ${shared} / ${turns[0]!.n + 1} |
| Task non conclusi | ${failedTasks[0]!.n} |
| Tempo totale | ${seconds.toFixed(1)} s |

**Esito: ${ok ? "SUPERATO" : "NON SUPERATO"}** — ${ok ? "nessuna sorgente persa, nessuna pagina duplicata." : "vedi le righe sopra."}
`;
await mkdir(path.resolve(here, "../../docs/spikes"), { recursive: true });
await writeFile(path.resolve(here, "../../docs/spikes/phase3-crash.md"), report);
console.log(report);
s.dispatcher.stop();
await s.sql.end();
process.exit(ok ? 0 : 1);
