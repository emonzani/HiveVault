<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { session } from "../lib/session.svelte.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { t } from "../lib/i18n.ts";

  const kind = $derived(ws.tab.view.kind);
  const items = [
    { icon: "search", label: t("Cerca"), keys: t("Ctrl Maiusc F"), run: (e: MouseEvent) => ws.open({ kind: "search", q: "" }, e.ctrlKey ? "tab" : "here"), on: () => kind === "search" },
    { icon: "switch", label: t("Apri una pagina"), keys: t("Ctrl O"), run: () => (ui.palette = "switcher"), on: () => false },
    { icon: "graph", label: t("Grafo"), keys: "", run: (e: MouseEvent) => ws.open({ kind: "graph" }, e.ctrlKey ? "tab" : "here"), on: () => kind === "graph" },
    { icon: "inbox", label: t("Inbox e da rivedere"), keys: "", run: (e: MouseEvent) => ws.open({ kind: "inbox", tab: "inbox" }, e.ctrlKey ? "tab" : "here"), on: () => kind === "inbox" },
  ];
</script>

<nav class="ribbon" aria-label={t("Azioni principali")}>
  <button class="toggle icon-btn" aria-pressed={ui.leftOpen} title={t("Barra laterale (Ctrl B)")} aria-label={t("Mostra o nascondi la barra laterale")} onclick={() => (ui.leftOpen = !ui.leftOpen)}>
    <Icon name="sidebar" />
  </button>
  {#each items as it (it.icon)}
    <button class="icon-btn" class:on={it.on()} title={it.keys ? `${it.label} (${it.keys})` : it.label} aria-label={it.label} onclick={it.run}>
      <Icon name={it.icon} />
    </button>
  {/each}
  {#if session.writable.length}
    <button class="icon-btn" title={t("Nuova pagina (Alt N)")} aria-label={t("Nuova pagina")} onclick={() => (ui.newPage = {})}><Icon name="plus" /></button>
    <button class="icon-btn" title={t("Carica documenti")} aria-label={t("Carica documenti")} onclick={() => (ui.upload = {})}><Icon name="upload" /></button>
  {/if}
  <span class="grow"></span>
  {#if session.me?.isAdmin}
    <button class="icon-btn" class:on={kind === "dashboard"} title={t("Dashboard")} aria-label={t("Dashboard")} onclick={(e) => ws.open({ kind: "dashboard", id: "panoramica" }, e.ctrlKey ? "tab" : "here")}><Icon name="gauge" /></button>
    <button class="icon-btn" class:on={kind === "admin"} title={t("Console di amministrazione")} aria-label={t("Console di amministrazione")} onclick={(e) => ws.open({ kind: "admin", section: "utenti" }, e.ctrlKey ? "tab" : "here")}><Icon name="console" /></button>
  {/if}
  <button class="icon-btn" title={t("Comandi (Ctrl K)")} aria-label={t("Palette dei comandi")} onclick={() => (ui.palette = "commands")}><Icon name="command" /></button>
  <button class="icon-btn" class:on={kind === "agent"} title={t("Cosa ha letto l'agente cloud")} aria-label={t("Cosa ha letto l'agente cloud")} onclick={() => ws.open({ kind: "agent" })}><Icon name="agent" /></button>
  <button class="icon-btn" class:on={kind === "account"} title={t("Il mio account")} aria-label={t("Il mio account")} onclick={() => ws.open({ kind: "account" })}><Icon name="user" /></button>
</nav>

<style>
  .ribbon {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--line);
    min-height: 0;
  }
  .toggle {
    margin-bottom: 0.4rem;
  }
  .grow {
    flex: 1;
  }
  .icon-btn {
    width: 2.1rem;
    height: 2.1rem;
  }
  .on {
    background: var(--ink-2);
    color: var(--text-main);
  }
</style>
