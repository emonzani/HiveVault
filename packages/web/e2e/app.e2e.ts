// Main flows of the web app (plan §10, phase 4). Every test runs once per theme.
import { readSeed } from "./global.ts";
import { expect, openBySwitcher, ready, test, totpCode } from "./helpers.ts";

const seed = readSeed();
const T = (name: string) => `${name} ${seed.run}`;

test.describe("accesso", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("accesso con TOTP e informativa sull'agente cloud", async ({ page, theme }) => {
    const u = seed.login[theme]!;
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Accedi" })).toBeVisible();
    await page.getByLabel("Nome utente").fill(u.username);
    await page.getByLabel("Codice dell'app di autenticazione").fill(totpCode(u.secret, Date.now() + 30_000));
    await page.getByRole("button", { name: "Accedi", exact: true }).click();
    const notice = page.getByRole("dialog", { name: /l'agente cloud e i dati dell'azienda/ });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("I documenti originali non escono mai dal server");
    // Escape does not dismiss the notice: the confirmation is required
    await page.keyboard.press("Escape");
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Ho letto e ho capito" }).click();
    await expect(notice).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: /Buongiorno|Buon pomeriggio|Buonasera/ })).toBeVisible();
    // the confirmation is stored: after a reload the notice does not come back
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: /Buongiorno|Buon pomeriggio|Buonasera/ })).toBeVisible();
    await expect(notice).toBeHidden();
  });

  test("codice sbagliato: messaggio chiaro", async ({ page, theme }) => {
    await page.goto("/");
    await page.getByLabel("Nome utente").fill(seed.login[theme]!.username);
    await page.getByLabel("Codice dell'app di autenticazione").fill("000000");
    await page.getByRole("button", { name: "Accedi", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });
});

test("quick switcher, wikilink, anteprima, cronologia e apertura < 100 ms", async ({ page }) => {
  await page.goto("/");
  await openBySwitcher(page, T("Alfa"));
  const body = page.locator(".md.body");
  const link = body.getByRole("link", { name: T("Beta") });
  // hover preview of the linked page
  await link.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText(T("Beta"));
  await expect(card).toContainText("120 postazioni");
  // the hovered page is prefetched: opening it is instant
  await page.evaluate(() => performance.clearMeasures("cb-page-open"));
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: T("Beta") })).toBeVisible();
  await expect(body.locator(".callout-conflict")).toContainText("150 postazioni");
  const ms = await page.evaluate(() => performance.getEntriesByName("cb-page-open").at(-1)?.duration ?? 9999);
  console.log(`[misura] apertura di una pagina già vista o sorvolata: ${ms.toFixed(1)} ms`);
  expect(ms, `apertura della pagina in ${Math.round(ms)} ms`).toBeLessThan(100);
  // backlinks of Beta include Alfa
  await expect(page.getByRole("complementary", { name: "Dettagli della pagina" })).toContainText(T("Alfa"));
  // history: Alt+← returns to Alfa, Alt+→ goes forward again
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("heading", { level: 1, name: T("Alfa") })).toBeVisible();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("heading", { level: 1, name: T("Beta") })).toBeVisible();
  // the address shows the page: a reload opens it again
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: T("Beta") })).toBeVisible();
});

test("ricerca a faccette con anteprima", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.keyboard.press("Control+Shift+F");
  const box = page.getByRole("searchbox", { name: "Cerca nella memoria" });
  await expect(box).toBeFocused();
  await box.fill(`postazioni ${seed.run}`);
  const results = page.getByRole("list", { name: "Risultati" });
  await expect(results.getByRole("button").first()).toBeVisible();
  await expect(results).toContainText(T("Beta"));
  await page.getByRole("group", { name: "Tipo di pagina" }).getByRole("button", { name: "Entità" }).click();
  await expect(results).toContainText(T("Beta"));
  await expect(page.getByRole("complementary", { name: "Anteprima" })).toContainText("postazioni");
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("modifica con autocompletamento dei link e salvataggio", async ({ page, theme }) => {
  await page.goto(`/#/p/${seed.pages.alfa}`);
  await expect(page.getByRole("heading", { level: 1, name: T("Alfa") })).toBeVisible();
  await page.keyboard.press("Control+e");
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.click();
  // tags of the vault in the frontmatter, the most used first
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type("\ntags: cli");
  const tip = page.locator(".cm-tooltip-autocomplete");
  await expect(tip).toContainText("clienti");
  await expect(tip).toContainText("2 pagine");
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("tags: clienti");
  // the test saves the page in every theme: the line goes again
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(editor).not.toContainText("tags:");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n\n## Nota ${theme}\nVedi [[Gamm`);
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText(T("Gamma"));
  await page.keyboard.press("Enter");
  await expect(editor).toContainText(`[[${T("Gamma")}]]`);
  await expect(page.getByText("Modifiche non salvate")).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status").filter({ hasText: /Salvato \(versione \d+\)/ })).toBeVisible();
  const section = page.locator(".md.body");
  await expect(section.getByRole("heading", { name: `Nota ${theme}` })).toBeVisible();
  await expect(section.getByRole("link", { name: T("Gamma") }).last()).toHaveAttribute("data-page", /.+/);
});

test("caricamento con avviso sull'agente cloud e stato in tempo reale", async ({ page, theme }) => {
  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "Carica documenti" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Carica nella memoria" });
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="file"]').setInputFiles({
    name: `verbale-${theme}-${seed.run}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(`# Verbale ${theme}\n\nRiunione con ${T("Beta")}: confermate 130 postazioni per il ${theme}.\n`),
  });
  await dlg.getByRole("combobox", { name: "Vault" }).selectOption(seed.vaultId);
  await expect(dlg).toContainText("può essere letto dall'agente cloud");
  await dlg.getByRole("combobox", { name: "Classificazione" }).selectOption({ label: "riservato" });
  await expect(dlg).toContainText("L'agente cloud non leggerà questi documenti");
  await dlg.getByRole("button", { name: /^Carica 1 file/ }).click();
  await expect(dlg).toContainText(`verbale-${theme}-${seed.run}.md`);
  // status from the server-sent events: the document becomes searchable
  await expect(dlg.getByText(/Cercabile|Compilato/)).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole("button", { name: "Fatto" }).click();
  await expect(page.locator("table")).toContainText(`Verbale ${theme}`);
});

test("da rivedere: cambio del link ed eliminazione dal pannello", async ({ page, theme }) => {
  const title = `Rivedere ${theme} ${seed.run}`;
  await page.goto("/#/da-rivedere");
  await ready(page);
  const row = page.getByRole("row").filter({ hasText: title });
  await row.getByRole("button", { name: `Rivedi ${title}` }).click();
  const panel = page.locator(".si");
  await expect(panel.getByRole("heading", { name: title })).toBeVisible();
  await expect(panel).toContainText(`https://example.com/${theme}/${seed.run}`);
  // change of link: the form starts from the current address and can be closed
  await panel.getByRole("button", { name: "Cambia link" }).click();
  await expect(panel.getByRole("textbox", { name: "Nuovo indirizzo" })).toHaveValue(`https://example.com/${theme}/${seed.run}`);
  await panel.getByRole("button", { name: "Annulla" }).click();
  await expect(panel.getByRole("textbox", { name: "Nuovo indirizzo" })).toHaveCount(0);
  // delete, after a confirmation
  page.once("dialog", (d) => d.accept());
  await panel.getByRole("button", { name: "Elimina" }).click();
  await expect(page.getByRole("status").filter({ hasText: "eliminato" })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("pannelli divisi, schede e grafo", async ({ page }) => {
  await page.goto(`/#/p/${seed.pages.alfa}`);
  await expect(page.getByRole("heading", { level: 1, name: T("Alfa") })).toBeVisible();
  await page.keyboard.press("Control+Backslash");
  await expect(page.getByRole("region", { name: /Pannello/ })).toHaveCount(2);
  await page.getByRole("button", { name: "Grafo", exact: true }).click();
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByText(/\d+ pagine · \d+ collegamenti/)).toBeVisible();
  await page.keyboard.press("Control+Backslash");
  await expect(page.getByRole("region", { name: /Pannello/ })).toHaveCount(1);
  // command palette
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("tema chiaro");
  await expect(page.getByRole("option").first()).toContainText("Tema: Chiaro");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "chiaro");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  // the shortcut may land while the closing dialog still has the focus: press until it opens
  await expect(async () => {
    if (!(await page.getByRole("combobox").isVisible())) await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
  await page.getByRole("combobox").fill("tema scuro");
  await expect(page.getByRole("option").first()).toContainText("Tema: Scuro");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});

test("filtro dei vault del grafo: ricerca, scelta, rimozione", async ({ page }) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await page.goto("/#/grafo");
  await expect(page.locator("canvas").first()).toBeVisible();
  const filter = page.getByRole("group", { name: "Vault" });
  await expect(filter.getByRole("button", { name: /Tutti i vault/ })).toHaveAttribute("aria-pressed", "true");
  await filter.getByRole("button", { name: "Scegli i vault" }).click();
  const panel = page.getByRole("dialog", { name: "Scegli i vault" });
  await expect(panel.getByRole("searchbox")).toBeFocused();
  await panel.getByRole("searchbox").fill("cella di nome cognomeeee");
  await expect(panel.getByRole("checkbox")).toHaveCount(1);
  const axe = await new AxeBuilder({ page }).include(".vf").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await page.keyboard.press("Enter");
  const chosen = filter.getByRole("button", { name: "Togli Cella di Nome CognomeEEE dal filtro" });
  await expect(chosen).toBeVisible();
  await expect(filter.getByRole("button", { name: /Tutti i vault/ })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(filter.getByRole("button", { name: "Scegli i vault" })).toBeFocused();
  await chosen.click();
  await expect(filter.getByRole("button", { name: /Tutti i vault/ })).toHaveAttribute("aria-pressed", "true");
});

test("accessibilità WCAG 2.1 AA delle viste principali (axe)", async ({ page }) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const views = [`/#/p/${seed.pages.beta}`, `/#/cerca?q=${encodeURIComponent(`postazioni ${seed.run}`)}`, "/#/inbox", "/#/da-rivedere", "/#/", "/#/account"];
  const problems: string[] = [];
  for (const v of views) {
    await page.goto(v);
    await ready(page);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const x of r.violations) problems.push(`${v} ${x.id}: ${x.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1] ?? ""}`).join(" | ")}`);
  }
  expect(problems).toEqual([]);
});

// Screens for the documentation (docs/ui): run with SCREENSHOTS=1.
test("schermate per la documentazione", async ({ page, theme }) => {
  test.skip(!process.env.SCREENSHOTS, "solo con SCREENSHOTS=1");
  const dir = "../../docs/ui";
  await page.goto(`/#/p/${seed.pages.beta}`);
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: T("Beta") })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}/pagina-${theme}.png` });
  if (theme !== "chiaro") return;
  await page.locator(".md.body").getByRole("link", { name: T("Alfa") }).hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.screenshot({ path: `${dir}/anteprima-link.png` });
  await page.goto(`/#/cerca?q=${encodeURIComponent(`postazioni ${seed.run}`)}`);
  await expect(page.getByRole("list", { name: "Risultati" }).getByRole("button").first()).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/ricerca.png` });
  await page.goto("/#/grafo");
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/grafo.png` });
  await page.goto(`/#/p/${seed.pages.alfa}`);
  await ready(page);
  await page.keyboard.press("Control+e");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/editor.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Carica documenti" }).first().click();
  await page.getByRole("dialog", { name: "Carica nella memoria" }).locator('input[type="file"]').setInputFiles({ name: "offerta-2026.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/caricamento.png` });
  await page.keyboard.press("Escape");
  await page.goto("/#/curatori");
  await expect(page.locator(".card").first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/curatori.png` });
  await page.locator(".card.conflict h2 a").first().click();
  await expect(page.locator(".callout-conflict")).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/alveare.png` });
});

test("coda dei curatori: conflitto tra celle deciso dall'interfaccia", async ({ page }) => {
  await page.goto("/#/curatori");
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: "Coda dei curatori" })).toBeVisible();
  // the first run (theme) decides; the next ones find the decision in "Decise"
  const card = page.locator(".card").filter({ hasText: `Delta ${seed.run}` });
  await expect(page.locator(".items, .empty")).toBeVisible();
  if (await card.count()) {
    await expect(card).toContainText("postazioni");
    await expect(card).toContainText("Cella di Nome CognomeEEE");
    await expect(card).toContainText("Cella di Nome CognomeFFF");
    await card.getByRole("listitem").filter({ hasText: "95" }).getByRole("button", { name: "Scegli" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Valore scelto" })).toBeVisible();
    await expect(card).toHaveCount(0);
  }
  await page.getByRole("tab", { name: "Decise" }).click();
  await expect(card).toContainText("scelto «95»");
  // the hive page shows the decision, with its provenance
  await card.getByRole("link", { name: `Delta ${seed.run}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Delta ${seed.run}` })).toBeVisible();
  const body = page.locator(".md.body");
  await expect(body).toContainText("Postazioni: 95");
  await expect(body).toContainText("deciso da un curatore");
  await expect(body).toContainText("Rinnovo: 2027-05-01");
  await expect(body).toContainText("2 fonti concordi");
  await expect(page.getByText(/Alveare · 2 celle/)).toBeVisible();
  await expect(body.locator(".callout-conflict")).toHaveCount(0);
});

test("proposta di modifica dell'agente cloud approvata dalla coda", async ({ page }) => {
  await page.goto("/#/curatori");
  await ready(page);
  await page.getByRole("button", { name: "Proposte dell'agente cloud" }).click();
  const card = page.locator(".card.proposal").filter({ hasText: `Gamma ${seed.run}` });
  await expect(page.locator(".items, .empty")).toBeVisible();
  if (await card.count()) {
    await expect(card).toContainText("agent-test");
    await expect(card.locator(".diff .add")).toContainText("Responsabile tecnico da ottobre");
    await card.getByRole("button", { name: "Approva e applica" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Modifica applicata" })).toBeVisible();
  }
  await page.goto("/");
  await openBySwitcher(page, `Gamma ${seed.run}`);
  await expect(page.locator(".md.body")).toContainText("Responsabile tecnico da ottobre");
});

test("schede e link salvati prima di una rinomina aprono la vista nuova", async ({ page }) => {
  // a workspace saved by the version where the view was called "claude", and a tab of a view
  // no version knows: the first opens "Cosa ha letto l'agente cloud", the second is dropped
  await page.goto("/");
  await ready(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "cb-workspace",
      // the active tab takes the view of the URL on load: the saved views sit in the other tabs
      JSON.stringify([{ active: 2, tabs: [{ id: "old1", view: { kind: "claude" }, title: "Cosa ha letto Claude" }, { id: "old2", view: { kind: "sparita" }, title: "?" }, { id: "old3", view: { kind: "home" }, title: "" }] }]),
    ),
  );
  await page.reload();
  await ready(page);
  const tabs = page.getByRole("tablist", { name: "Schede" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toHaveText("Cosa ha letto l'agente cloud");
  await tabs.first().click();
  await expect(page).toHaveURL(/#\/agente$/);
  // the old link of the same view
  await page.goto("/#/claude");
  await expect(page).toHaveURL(/#\/agente$/);
});

test.describe("lingua del browser", () => {
  test.describe("inglese", () => {
    test.use({ locale: "en-US" });

    test("la home è in inglese", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: /Good morning|Good afternoon|Good evening/ })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    });
  });

  test.describe("francese, senza sessione", () => {
    test.use({ locale: "fr-FR", storageState: { cookies: [], origins: [] } });

    test("l'accesso è in francese", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Se connecter" })).toBeVisible();
      await expect(page.getByLabel("Nom d'utilisateur")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    });
  });
});
