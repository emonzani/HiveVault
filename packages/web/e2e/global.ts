// Global setup and teardown: seed the test data with tsx (the server packages are TypeScript
// run by tsx), keep the state in e2e/.state for the tests, delete the data at the end.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STATE_DIR = path.join(import.meta.dirname, ".state");
export const SEED_FILE = path.join(STATE_DIR, "seed.json");
const ROOT = path.resolve(import.meta.dirname, "../../..");

export interface Seed {
  run: string;
  main: { id: string; username: string; secret: string };
  admin: { id: string; username: string; secret: string };
  login: Record<string, { username: string; secret: string }>;
  vaultId: string;
  cellId: string;
  hiveId: string;
  pages: { alfa: string; beta: string };
}

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as Seed;
}

function tsx(args: string[]): string {
  return execFileSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "packages/web/e2e/seed.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, LOG_LEVEL: "error" },
    encoding: "utf8",
  });
}

export default function globalSetup() {
  mkdirSync(STATE_DIR, { recursive: true });
  const out = tsx([]);
  writeFileSync(SEED_FILE, out.slice(out.indexOf("{")));
  return () => tsx(["--clean", readSeed().run]);
}
