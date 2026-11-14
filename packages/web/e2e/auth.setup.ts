// Logs the main test user in once (TOTP over the API) and saves the session for the flows.
import { test as setup, expect } from "@playwright/test";
import { readSeed } from "./global.ts";
import { totpCode } from "./helpers.ts";

setup("accesso dell'utente di prova", async ({ request }) => {
  const seed = readSeed();
  // the enrollment consumed the code of the current window: use the next one (±1 step allowed)
  const r = await request.post("/api/auth/login/totp", { data: { username: seed.main.username, code: totpCode(seed.main.secret, Date.now() + 30_000) } });
  expect(r.status(), await r.text()).toBe(200);
  await request.storageState({ path: "e2e/.state/main.json" });
});

setup("accesso dell'amministratore di prova", async ({ request }) => {
  const seed = readSeed();
  const r = await request.post("/api/auth/login/totp", { data: { username: seed.admin.username, code: totpCode(seed.admin.secret, Date.now() + 30_000) } });
  expect(r.status(), await r.text()).toBe(200);
  await request.storageState({ path: "e2e/.state/admin.json" });
});
