import postgres from "postgres";
import { databaseUrl } from "@cb/shared";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

export interface DbOptions {
  url?: string;
  max?: number;
  /** pgbouncer in transaction mode does not support prepared statements across transactions. */
  prepare?: boolean;
  application?: string;
  /**
   * false: commits do not wait for the WAL flush (`synchronous_commit = off`). For workers
   * whose writes are idempotent (task phases): a database crash can lose the last commits,
   * which then run again; data is never corrupted.
   */
  synchronousCommit?: boolean;
}

export function createDb(opts: DbOptions = {}): Sql {
  return postgres(opts.url ?? databaseUrl(), {
    max: opts.max ?? 10,
    prepare: opts.prepare ?? true,
    idle_timeout: 30,
    connection: {
      application_name: opts.application ?? "hivevault",
      ...(opts.synchronousCommit === false ? { synchronous_commit: "off" } : {}),
    },
    onnotice: () => {},
    // bigint -> number is safe for counters in this project; ids are text (ULID)
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => x.toString(), parse: (x: string) => Number(x) },
    },
  });
}

/** True when Postgres answers within the timeout. Tests use it to skip with a clear message. */
export async function isDbReachable(url = databaseUrl(), timeoutMs = 2000): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: Math.ceil(timeoutMs / 1000), onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export { migrate, type MigrationResult } from "./migrate.ts";
