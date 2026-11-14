// Test database helper: creates (once) and migrates `brain_test` next to the main database.
import postgres from "postgres";
import { createDb, isDbReachable, migrate, type Sql } from "./index.ts";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://brain:brain@127.0.0.1:5432/brain";
const TEST_DB = "brain_test";

export function testDatabaseUrl(): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/** Returns undefined (and says why) when Postgres is not reachable: tests then skip. */
export async function setupTestDb(): Promise<Sql | undefined> {
  if (!(await isDbReachable(ADMIN_URL))) {
    console.warn("Postgres is not reachable: database tests are skipped. Run `npm run db:up`.");
    return undefined;
  }
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  const [exists] = await admin`select 1 from pg_database where datname = ${TEST_DB}`;
  if (!exists) {
    try {
      await admin.unsafe(`create database ${TEST_DB}`);
    } catch (e) {
      // test files start in parallel: another one may create it at the same moment
      if (!["42P04", "23505"].includes((e as { code?: string }).code ?? "")) throw e;
    }
  }
  await admin.end();
  const sql = createDb({ url: testDatabaseUrl(), max: 20, application: "cb-test" });
  await migrate(sql);
  return sql;
}
