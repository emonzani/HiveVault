import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "@cb/blobs";
import { PageStore, SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { parseFile } from "@cb/parsers";
import { ulid } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import { generateFormats } from "../../../bench/corpus/formats.ts";
import { Compiler, defineImportTask, defineIngestTask, globToRegExp, ImportError, ImportService, openImportFile, SourceStore } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
const tmp = await mkdtemp(path.join(os.tmpdir(), "cb-import-"));
const allowedRoot = path.join(tmp, "condivisa");
const share = path.join(allowedRoot, "ufficio-tecnico");
await generateFormats(path.join(tmp, "src"), 2, 31);
await cp(path.join(tmp, "src"), share, { recursive: true });
await mkdir(path.join(share, "sotto", "cartella"), { recursive: true });
await writeFile(path.join(share, "sotto", "cartella", "Thumbs.db"), "junk");
await writeFile(path.join(share, "sotto", "~$documento.docx"), "lock file");
await writeFile(path.join(share, "sotto", "copia.md"), "---\ntitle: x\n---\nduplicato"); // unique content
await cp(path.join(share, "md", "nota-0.md"), path.join(share, "sotto", "cartella", "nota-0-copia.md")); // same content: duplicate
await writeFile(path.join(share, "grande.txt"), Buffer.alloc(600 * 1024, 65));
// a folder outside the import roots, as the files of the server
const server = path.join(tmp, "server");
await mkdir(server);
await writeFile(path.join(server, "notes.txt"), "SERVER SECRET");
// symlinks can need a privilege on Windows: their tests skip where they cannot be created
const canLink = (target: string, type: "junction" | "file") =>
  symlink(target, path.join(tmp, `probe-${type}`), type).then(
    () => true,
    () => false,
  );
const links = await canLink(server, "junction");
const fileLinks = await canLink(path.join(server, "notes.txt"), "file");

const store = sql ? new SourceStore(sql, new FsBlobStore(path.join(tmp, "blobs"), randomBytes(32))) : undefined;
const ingestTask = sql
  ? defineIngestTask({
      store: store!,
      parse: (d, n) => parseFile(d, n),
      indexer: () => null, // I1 only: the import test checks storing and indexing
      compiler: new Compiler(sql, store!, new PageStore(sql), new SearchEngine(sql, undefined, { dims: 16, embedModel: "m" }), undefined, { useModel: "never" }),
      chunk: { minTokens: 1 },
      name: `ingest-imp-${run}`,
    })
  : undefined;
const importTask = sql ? defineImportTask({ sql, store: store!, ingestTask: ingestTask!, roots: [allowedRoot], batch: 7, name: `import-${run}` }) : undefined;
const engine = sql ? new TaskEngine(sql, { pollMs: 50, concurrency: 6 }).register(ingestTask!, importTask!) : undefined;
const imports = sql ? new ImportService(sql, engine!, importTask!, [allowedRoot]) : undefined;
await engine?.start();
afterAll(async () => {
  await engine?.stop();
  await rm(tmp, { recursive: true, force: true });
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

async function waitJob(id: string, status = "done", timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const j = (await imports!.get(id))!;
    if (j.status === status) return j;
    if (j.status === "failed") throw new Error(`import failed: ${j.error}`);
    if (Date.now() > end) throw new Error(`timeout, status ${j.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function waitIngest(vaultId: string) {
  for (let i = 0; i < 900; i++) {
    const [r] = await sql!<{ open: number }[]>`
      select count(*)::int as open from sources s left join tasks t on t.id = s.task_id
      where s.vault_id = ${vaultId} and (t.id is null or t.status not in ('done', 'failed', 'cancelled'))`;
    if (r!.open === 0) return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("ingestion did not finish");
}

describe("globs", () => {
  it("supports **, * and ? and ignores case", () => {
    expect(globToRegExp("**/*.pdf").test("a/b/c.PDF")).toBe(true);
    expect(globToRegExp("**/*.pdf").test("c.pdf")).toBe(true);
    expect(globToRegExp("archivio/*.eml").test("archivio/sub/x.eml")).toBe(false);
    expect(globToRegExp("bozze/**").test("bozze/a/b.docx")).toBe(true);
    expect(globToRegExp("v?.txt").test("v1.txt")).toBe(true);
  });
});

describe("opening a scanned file", () => {
  const read = async (root: string, rel: string) => {
    const fh = await openImportFile(root, rel);
    try {
      return await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  };
  const folder = async (name: string) => {
    const d = path.join(tmp, "open", name);
    await mkdir(path.join(d, "zz"), { recursive: true });
    await writeFile(path.join(d, "zz", "notes.txt"), "notes");
    return realpath(d);
  };

  it("reads a regular file and refuses a folder in its place", async () => {
    const root = await folder("plain");
    expect(await read(root, "zz/notes.txt")).toBe("notes");
    await expect(read(root, "zz")).rejects.toThrow(/not a regular file/);
  });

  it("reads a root written in another letter case than the folder on disk, where the file system ignores case", async ({ skip }) => {
    const root = await folder("CaseDir");
    const other = path.join(path.dirname(root), "casedir");
    if (!(await stat(other).catch(() => null))) skip();
    expect(await read(other, "zz/notes.txt")).toBe("notes");
  });

  it("refuses a file swapped for a symlink to a file outside", async ({ skip }) => {
    if (!fileLinks) skip();
    const root = await folder("leaf");
    await rm(path.join(root, "zz", "notes.txt"));
    await symlink(path.join(server, "notes.txt"), path.join(root, "zz", "notes.txt"), "file");
    await expect(read(root, "zz/notes.txt")).rejects.toThrow(/ELOOP|outside the import folder/);
  });

  it("refuses a file under a folder swapped for a symlink to a folder outside", async ({ skip }) => {
    if (!links) skip();
    const root = await folder("dir");
    await rm(path.join(root, "zz"), { recursive: true });
    await symlink(server, path.join(root, "zz"), "junction");
    await expect(read(root, "zz/notes.txt")).rejects.toThrow(/outside the import folder/);
  });

  it("refuses a root whose parent folder was swapped for a symlink to another share", async ({ skip }) => {
    if (!links) skip();
    const shares = path.join(tmp, "open", "shares");
    for (const [team, text] of [["team-a", "team a"], ["team-b", "HR SECRET"]]) {
      await mkdir(path.join(shares, team!, "share"), { recursive: true });
      await writeFile(path.join(shares, team!, "share", "x.txt"), text!);
    }
    const root = await realpath(path.join(shares, "team-a", "share"));
    expect(await read(root, "x.txt")).toBe("team a");
    await rename(path.join(shares, "team-a"), path.join(shares, "team-a-old"));
    await symlink(path.join(shares, "team-b"), path.join(shares, "team-a"), "junction");
    await expect(read(root, "x.txt")).rejects.toThrow(/import folder changed/);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO without waiting for a writer", async () => {
    const root = await folder("fifo");
    execFileSync("mkfifo", [path.join(root, "zz", "pipe")]);
    await expect(read(root, "zz/pipe")).rejects.toThrow(/not a regular file/);
  });
});

describe("bulk import", () => {
  db()("imports a folder tree: files stored and ingested, junk skipped, duplicates and large files reported", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "space", slug: `imp-${run}`, name: "Import" });
    const job = await imports!.create({ vaultId: v.id, root: share, exclude: ["**/*.png"], maxFileBytes: 500 * 1024 });
    const done = await waitJob(job.id);
    // 13 formats x 2 = 26 files - 2 png (excluded) + copia.md + nota-0-copia.md = 26 stored (1 of them a duplicate); grande.txt skipped
    expect(done.stats).toMatchObject({ scanned: 27, stored: 26, skipped: 1, errors: 0, duplicates: 1, pending: 0 });
    const files = await sql!<{ rel_path: string; status: string; reason: string | null }[]>`select rel_path, status, reason from import_files where job_id = ${job.id}`;
    expect(files.find((f) => f.rel_path === "grande.txt")).toMatchObject({ status: "skipped", reason: "too_large" });
    expect(files.find((f) => f.rel_path.endsWith("nota-0-copia.md"))).toMatchObject({ status: "stored", reason: "duplicate" });
    expect(files.some((f) => /Thumbs\.db|~\$/.test(f.rel_path))).toBe(false);
    await waitIngest(v.id);
    const lv = await sql!<{ level: number; n: number }[]>`select level, count(*)::int as n from sources where vault_id = ${v.id} group by level order by level`;
    expect(lv.every((l) => l.level === 1)).toBe(true); // I1: indexer disabled in this test
    const [{ n }] = (await sql!`select count(*)::int as n from sources where vault_id = ${v.id} and origin = 'import' and path like 'sotto/%'`) as unknown as [{ n: number }];
    expect(n).toBe(1);

    // rescan: one changed file and one new file are the only ones read again
    await writeFile(path.join(share, "md", "nota-1.md"), "# Nota cambiata\n\nNuovo contenuto " + run);
    await utimes(path.join(share, "md", "nota-1.md"), new Date(), new Date(Date.now() + 5000));
    await writeFile(path.join(share, "nuovo.txt"), "File aggiunto dopo " + run);
    await imports!.rescan(job.id);
    const again = await waitJob(job.id);
    const changed = await sql!<{ rel_path: string }[]>`
      select f.rel_path from import_files f join sources s on s.id = f.source_id
      where f.job_id = ${job.id} and s.created_at > ${done.finishedAt!}`;
    expect(changed.map((c) => c.rel_path).sort()).toEqual(["md/nota-1.md", "nuovo.txt"]);
    expect(again.stats.scanned).toBe(28);
    await waitIngest(v.id);
  }, 120_000);

  db()("pause stops the storing between batches, cancel ends the job", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "space", slug: `imp2-${run}`, name: "Import 2" });
    const job = await imports!.create({ vaultId: v.id, root: share, filesPerSec: 20 });
    for (let i = 0; i < 100 && ((await imports!.get(job.id))!.stats.stored ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await imports!.setStatus(job.id, "paused");
    await new Promise((r) => setTimeout(r, 1200)); // the batch in progress finishes
    const a = (await imports!.get(job.id))!.stats.stored ?? 0;
    await new Promise((r) => setTimeout(r, 1000));
    const b = (await imports!.get(job.id))!.stats.stored ?? 0;
    expect(b).toBe(a); // nothing stored while paused
    expect(b).toBeLessThan(28);
    await imports!.setStatus(job.id, "cancelled");
    await expect(imports!.setStatus(job.id, "running")).rejects.toBeInstanceOf(ImportError);
  }, 60_000);

  db()("settings of a job change while it waits: only the given fields, window checked", async () => {
    const v = await new VaultStore(sql!, 16).create({ kind: "space", slug: `imp3-${run}`, name: "Import 3" });
    // a night window keeps the job from storing while the test changes it
    const job = await imports!.create({ vaultId: v.id, root: share, include: ["**/*.txt"], filesPerSec: 5, windowHours: "03:00-03:01" });
    const u = await imports!.update(job.id, { exclude: ["**/old/**"], filesPerSec: null, classification: 2, compile: true });
    expect(u).toMatchObject({ include: ["**/*.txt"], exclude: ["**/old/**"], filesPerSec: null, classification: 2, compile: true, windowHours: "03:00-03:01" });
    expect((await imports!.update(job.id, { windowHours: null })).windowHours).toBeNull();
    await expect(imports!.update(job.id, { windowHours: "sempre" })).rejects.toThrow(/Finestra oraria/);
    await expect(imports!.update("imp_nessuno", { compile: false })).rejects.toThrow(/non trovato/);
    await imports!.setStatus(job.id, "cancelled");
  });

  db()("store phase: a file or a folder swapped for a symlink after the scan is not read", async ({ skip }) => {
    if (!links) skip();
    const v = await new VaultStore(sql!, 16).create({ kind: "space", slug: `imp4-${run}`, name: "Import 4" });
    const root = path.join(allowedRoot, "scambio");
    await mkdir(path.join(root, "zz"), { recursive: true });
    await writeFile(path.join(root, "zz", "notes.txt"), "note " + run);
    await writeFile(path.join(root, "ok.txt"), "ok " + run);
    // a task the engine does not run: the test runs its phases, with the swap in between
    const manual = defineImportTask({ sql: sql!, store: store!, ingestTask: ingestTask!, roots: [allowedRoot], name: `import-manual-${run}` });
    const job = await new ImportService(sql!, engine!, manual, [allowedRoot]).create({ vaultId: v.id, root });
    const ctx = {
      task: { input: { jobId: job.id }, state: {} },
      signal: new AbortController().signal,
      next: (phase: string, state: unknown) => ({ type: "next", phase, state }),
      done: (result: unknown) => ({ type: "done", result }),
      sleepUntil: (until: Date, phase: string, state: unknown) => ({ type: "sleep", until, phase, state }),
    } as never;
    expect(await manual.phases.scan!(ctx)).toMatchObject({ type: "next", phase: "store" });
    await rm(path.join(root, "zz"), { recursive: true });
    await symlink(server, path.join(root, "zz"), "junction");
    expect(await manual.phases.store!(ctx)).toMatchObject({ type: "next", phase: "store" });
    const files = await sql!<{ rel_path: string; status: string; reason: string | null }[]>`
      select rel_path, status, reason from import_files where job_id = ${job.id} order by rel_path`;
    expect(files).toMatchObject([
      { rel_path: "ok.txt", status: "stored" },
      { rel_path: "zz/notes.txt", status: "error", reason: "the file is outside the import folder" },
    ]);
    const paths = await sql!<{ path: string }[]>`select path from sources where vault_id = ${v.id}`;
    expect(paths.map((p) => p.path)).toEqual(["ok.txt"]);
    expect(await manual.phases.store!(ctx)).toMatchObject({ type: "done" });
    await engine!.cancel(job.taskId!);
    await waitIngest(v.id);
  });

  db()("refuses roots outside the allowed import roots", async () => {
    await expect(imports!.create({ vaultId: "x", root: tmp })).rejects.toThrow(/fuori dalle radici/);
    await expect(imports!.create({ vaultId: "x", root: path.join(allowedRoot, "..", "src") })).rejects.toThrow(/fuori dalle radici/);
    await expect(imports!.create({ vaultId: "x", root: path.join(allowedRoot, "non-esiste") })).rejects.toThrow(/non esiste/);
    const disabled = new ImportService(sql!, engine!, importTask!, []);
    await expect(disabled.create({ vaultId: "x", root: share })).rejects.toThrow(/IMPORT_ROOTS/);
  });
});
