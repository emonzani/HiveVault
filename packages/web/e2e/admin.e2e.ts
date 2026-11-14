// Console and dashboards (plan §8.3, §8.4, phase 7), as the administrator of the seed.
import { readSeed } from "./global.ts";
import { expect, ready, test } from "./helpers.ts";

const seed = readSeed();
test.use({ storageState: "e2e/.state/admin.json" });

test("console: account API con chiave mostrata una volta, permesso cercato per account e per vault, impostazioni", async ({ page, theme }) => {
  await page.goto("/#/admin/api");
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: "Account API" })).toBeVisible();

  // new API account: the key appears once, in the "secret" box
  await page.getByRole("button", { name: "Nuovo account API" }).click();
  const name = `e2e-${seed.run}-api-${theme}`; // one per theme: the seed is shared
  await page.getByLabel("Nome account").fill(name);
  await page.getByRole("button", { name: "Crea", exact: true }).click();
  const secret = page.getByRole("status").filter({ hasText: `Chiave di ${name}` });
  await expect(secret).toBeVisible();
  await expect(secret.locator("code")).toHaveText(/^cb_/);
  await secret.getByRole("button", { name: "Ho salvato, nascondi" }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();

  // permissions, by account: search the new account, add "read" on the space of the seed
  await page.goto("/#/admin/permessi");
  await page.getByLabel("Cerca un account").fill(name);
  await page.getByRole("list", { name: "Account" }).getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(page.getByText("Nessun permesso.")).toBeVisible();
  const vault = page.getByRole("combobox", { name: "Vault" });
  // the vaults are suggested as soon as the field gets the focus
  await vault.click();
  await expect(page.getByRole("listbox", { name: "Suggerimenti" }).getByRole("option").first()).toBeVisible();
  await vault.fill("Progetti E2E");
  await page.getByRole("option", { name: new RegExp(`^Progetti E2E ${seed.run}`) }).click();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/admin/grants") && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel(`Permesso su Progetti E2E ${seed.run}`, { exact: true })).toHaveValue("read");
  // the same grant seen from the vault
  await page.getByRole("tab", { name: "Per vault" }).click();
  await page.getByLabel("Cerca un vault").fill(`Progetti E2E ${seed.run}`);
  await page.getByRole("list", { name: "Vault" }).getByRole("button", { name: new RegExp(`Progetti E2E ${seed.run}`) }).first().click();
  await expect(page.getByLabel(`Permesso su ${name}`, { exact: true })).toHaveValue("read");

  // settings: the notice text is saved and comes back
  await page.goto("/#/admin/impostazioni");
  const text = page.locator("textarea");
  await expect(text).toBeVisible();
  const before = await text.inputValue();
  await text.fill(`Testo di prova ${seed.run}`);
  await page.locator("form").filter({ hasText: "Avviso sull'agente cloud" }).getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText("Impostazioni salvate.")).toBeVisible();
  await page.reload();
  await expect(page.locator("textarea")).toHaveValue(`Testo di prova ${seed.run}`);
  await page.locator("textarea").fill(before);
  await page.locator("form").filter({ hasText: "Avviso sull'agente cloud" }).getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText("Impostazioni salvate.").first()).toBeVisible();
});

test("console: i record si modificano (sorgente e vault) e le modifiche restano", async ({ page, theme }) => {
  // a document in the space of the seed, uploaded through the API as the administrator
  const csrf = (await page.context().cookies()).find((c) => c.name === "cb_csrf")!.value;
  const name = `nota-${seed.run}-${theme}.txt`;
  const up = await page.request.post(`/api/vaults/${seed.vaultId}/sources`, {
    headers: { "x-cb-csrf": csrf },
    multipart: { file: { name, mimeType: "text/plain", buffer: Buffer.from(`Verbale di prova ${theme}: rinnovo del contratto.`) } },
  });
  expect(up.status(), await up.text()).toBeLessThan(300);

  await page.goto("/#/admin/sorgenti");
  await ready(page);
  await page.getByRole("searchbox", { name: "Cerca" }).fill(name);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Modifica" }).click();
  await page.getByLabel("Titolo").fill(`Verbale ${theme}`);
  await page.getByLabel("Classificazione").selectOption({ label: "riservato" });
  await page.getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText(/^Sorgente aggiornata/)).toBeVisible();
  await page.reload();
  await page.getByRole("searchbox", { name: "Cerca" }).fill(name);
  const saved = page.getByRole("row").filter({ hasText: `Verbale ${theme}` });
  await expect(saved).toContainText("riservato");

  // vault: SCHEMA.md is read with the vault, edited and kept
  await page.goto(`/#/admin/vault/${seed.vaultId}`);
  const schema = page.getByLabel(/SCHEMA\.md/);
  await expect(schema).toBeVisible();
  const before = await schema.inputValue();
  await schema.fill(`${before}

## Regola di prova ${theme}`);
  await page.getByRole("button", { name: "Salva", exact: true }).first().click();
  await expect(page.getByText("Vault aggiornato.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/SCHEMA\.md/)).toHaveValue(new RegExp(`Regola di prova ${theme}`));
});

test("console: proprietario del vault scelto per tipo e nome, con suggerimenti", async ({ page, theme }) => {
  await page.goto("/#/admin/vault");
  await ready(page);
  await page.getByRole("button", { name: "Nuovo vault" }).click();
  const slug = `e2e-${seed.run}-own-${theme}`;
  await page.getByLabel("Identificativo").fill(slug);
  await page.getByLabel("Nome", { exact: true }).fill(`Cella ${theme}`);
  await page.getByLabel(/Tipo di proprietario/).selectOption({ label: "Utente" });
  const who = page.getByRole("combobox", { name: "Utente" });
  // a typed name is not a user until it is picked from the list
  await who.fill(seed.main.username);
  await expect(page.getByRole("option", { name: new RegExp(`${seed.main.username}$`) })).toBeVisible();
  await who.press("Tab");
  await expect(who).toHaveAttribute("aria-invalid", "true");
  await who.focus();
  await page.getByRole("option", { name: new RegExp(`${seed.main.username}$`) }).click();
  await expect(who).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Crea", exact: true }).click();
  await expect(page.getByText("Vault creato.")).toBeVisible();
  // the owner is stored by id and shown by name
  const row = page.getByRole("row").filter({ hasText: slug });
  await expect(row).toContainText("utente Nome CognomeEEE");
  await expect(page.getByRole("combobox", { name: "Utente" })).toHaveValue(/Nome CognomeEEE/);
});

test("console: ciclo notturno salvato, utente modificato dal pulsante, spiegazioni semplici", async ({ page, theme }) => {
  // night window: the time pattern accepts a valid value (it rejected every value before)
  await page.goto("/#/admin/impostazioni");
  await ready(page);
  const win = page.getByLabel("Finestra (HH:MM-HH:MM)");
  await expect(win).toBeVisible();
  const before = await win.inputValue();
  await win.fill("23:00-05:00");
  expect(await win.evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(true);
  await page.locator("form").filter({ hasText: "Ciclo notturno" }).getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText("Impostazioni salvate.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Finestra (HH:MM-HH:MM)")).toHaveValue("23:00-05:00");
  await page.getByLabel("Finestra (HH:MM-HH:MM)").fill(before);
  await page.locator("form").filter({ hasText: "Ciclo notturno" }).getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText("Impostazioni salvate.").first()).toBeVisible();

  // a user: the "Modifica" button of the row opens the form, with the focus in it
  await page.goto("/#/admin/utenti");
  await page.getByRole("searchbox", { name: "Cerca" }).fill(seed.main.username);
  const row = page.getByRole("row").filter({ has: page.getByText(seed.main.username, { exact: true }) });
  await row.getByRole("button", { name: "Modifica" }).click();
  const shown = page.getByLabel("Nome visibile");
  await expect(shown).toBeFocused();
  await shown.fill(`Nome CognomeEEE ${theme}`);
  await page.getByRole("complementary", { name: "Dettaglio account" }).getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `Nome CognomeEEE ${theme}` })).toHaveCount(1);

  // plain explanation: shown, and it stays closed once closed
  const ex = page.locator("details.explain").first();
  await expect(ex).toHaveAttribute("open", "");
  await ex.locator("summary").click();
  await page.reload();
  await expect(page.locator("details.explain").first()).not.toHaveAttribute("open", "");
});

test("console: ogni sezione si apre senza errori", async ({ page }) => {
  // [section, link label, page heading]
  const sections: [string, string, string?][] = [
    ["utenti", "Utenti"],
    ["vault", "Vault e spazi"],
    ["sorgenti", "Sorgenti"],
    ["import", "Import massivi"],
    ["task", "Task"],
    ["modelli", "Modelli"],
    ["audit", "Audit"],
    ["backup", "Backup", "Backup e ripristino"],
  ];
  await page.goto("/#/admin/utenti");
  await ready(page);
  for (const [id, label, title] of sections) {
    await page.getByRole("navigation", { name: "Sezioni della console" }).getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/admin/${id}`));
    await expect(page.getByRole("heading", { level: 1, name: title ?? label })).toBeVisible();
    await expect(page.locator(".content .notice.error")).toHaveCount(0);
  }
});

test("dashboard: dieci pannelli, vista tabella, layout spostato con la tastiera e salvato", async ({ page }) => {
  await page.goto("/#/dashboard/panoramica");
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: "Panoramica" })).toBeVisible();
  await expect(page.getByText(/aggiornati alle/)).toBeVisible();
  await expect(page.locator("section.panel")).toHaveCount(12);

  // every dashboard of the list opens and loads its data
  const list = page.getByRole("navigation", { name: "Dashboard" });
  await expect(list.getByRole("link")).toHaveCount(11); // 10 dashboards + the console
  for (const title of ["Ricerca", "Database", "Accessi e sicurezza", "Host"]) {
    await list.getByRole("link", { name: title, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(/aggiornati alle/)).toBeVisible();
  }

  // a chart has a table view
  await list.getByRole("link", { name: "Panoramica", exact: true }).click();
  const http = page.getByRole("region", { name: "Richieste HTTP" });
  await http.getByRole("button", { name: "Tabella" }).click();
  await expect(http.getByRole("columnheader", { name: "Serie" })).toBeVisible();

  // layout: move "Pagine" one column right with the keyboard; it stays after a reload
  const pagesPanel = page.getByRole("region", { name: "Pagine", exact: true });
  const x0 = (await pagesPanel.boundingBox())!.x;
  await page.getByRole("button", { name: "Modifica il layout" }).click();
  await page.getByRole("button", { name: /^Sposta Pagine:/ }).press("ArrowRight");
  await expect.poll(async () => (await pagesPanel.boundingBox())!.x).toBeGreaterThan(x0);
  await page.reload();
  await expect.poll(async () => (await page.getByRole("region", { name: "Pagine", exact: true }).boundingBox())!.x).toBeGreaterThan(x0);
  await page.getByRole("button", { name: "Modifica il layout" }).click();
  await page.getByRole("button", { name: "Ripristina il layout" }).click();
  await expect.poll(async () => Math.round((await page.getByRole("region", { name: "Pagine", exact: true }).boundingBox())!.x)).toBe(Math.round(x0));
});

test("accessibilità WCAG 2.1 AA di console e dashboard (axe)", async ({ page }) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const views = ["/#/admin/utenti", "/#/admin/permessi", `/#/admin/permessi/${seed.vaultId}`, `/#/admin/permessi/${seed.main.id}`, "/#/admin/vault", "/#/admin/task", "/#/admin/modelli", "/#/admin/impostazioni", "/#/dashboard/panoramica", "/#/dashboard/modelli"];
  const problems: string[] = [];
  for (const v of views) {
    await page.goto(v);
    await ready(page);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const x of r.violations) problems.push(`${v} ${x.id}: ${x.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
  }
  expect(problems).toEqual([]);
});
