import { defineConfig } from "@playwright/test";

// End-to-end tests of the web app (plan §10, phase 4): the main flows in both themes.
// The server serves the built app on its own port, with the database of `npm run db:up`.
// The browser is the Edge (or Chrome) installed on the machine: no browser download.
const PORT = Number(process.env.E2E_PORT ?? 3790);
export const BASE = `http://localhost:${PORT}`;
const THEMES = ["chiaro", "scuro"] as const;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.(e2e|setup)\.ts$/,
  globalSetup: "./e2e/global.ts",
  fullyParallel: false,
  workers: 1,
  // One retry for failures of the machine, not of the app: on Windows a page load sometimes
  // loses a request with net::ERR_NO_BUFFER_SPACE (WSAENOBUFS) and the shell never renders.
  // A test that passes only on the retry is reported as "flaky" (list output and last.json).
  retries: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  // the JSON report lives outside outputDir (emptied at every run): a failure that does not come
  // back on the next run still leaves its test name, error and trace path for the investigation
  reporter: [["list"], ["json", { outputFile: "e2e/.report/last.json" }]],
  outputDir: "e2e/.results",
  use: {
    baseURL: BASE,
    channel: process.env.E2E_CHANNEL ?? "msedge",
    viewport: { width: 1440, height: 900 },
    locale: "it-IT",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "auth", testMatch: /auth\.setup\.ts$/ },
    ...THEMES.map((theme) => ({
      name: theme,
      testMatch: /\.e2e\.ts$/,
      dependencies: ["auth"],
      metadata: { theme },
      use: { storageState: "e2e/.state/main.json" },
    })),
  ],
  webServer: {
    command: "npm run build -w @cb/web && node node_modules/tsx/dist/cli.mjs packages/server/src/index.ts",
    cwd: "../..",
    url: `${BASE}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      PUBLIC_URL: BASE,
      WEB_DIR: "packages/web/dist",
      LOGIN_RATE_LIMIT_PER_MIN: "200",
      RATE_LIMIT_PER_MIN: "5000",
      LOG_LEVEL: "error",
      // the seed leaves documents at I1 on purpose ("da rivedere"): with a chat model in the
      // .env of the machine, the compilation of the backlog (M3) would compile them and change them
      IDLE_COMPILE: "false",
    },
  },
});
