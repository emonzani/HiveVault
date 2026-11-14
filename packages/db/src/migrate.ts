import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Sql } from "./index.ts";

/**
 * Minimal migration runner: numbered SQL files (NNN_name.sql) applied in order, each in a transaction.
 * A checksum guards against editing an applied migration. An advisory lock serializes concurrent runners.
 */
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const LOCK_KEY = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(sql: Sql, dir = DEFAULT_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const rows = await tx<{ name: string; checksum: string }[]>`select name, checksum from schema_migrations`;
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const body = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} changed after it was applied. Add a new migration instead.`);
        result.skipped.push(file);
        continue;
      }
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name, checksum) values (${file}, ${checksum})`;
      result.applied.push(file);
    }
  });
  return result;
}
