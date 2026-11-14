<script lang="ts">
  // Administration console (plan §8.3): one section at a time, the section list on the left.
  // Every route checks the administrator role again; this view only hides what would fail.
  import Icon from "../../../components/Icon.svelte";
  import { session } from "../../../lib/session.svelte.ts";
  import { target } from "../../../lib/ui.svelte.ts";
  import { ADMIN_SECTIONS, ws, type AdminSection } from "../../../lib/workspace.svelte.ts";
  import Audit from "./Audit.svelte";
  import Backup from "./Backup.svelte";
  import Grants from "./Grants.svelte";
  import Imports from "./Imports.svelte";
  import Models from "./Models.svelte";
  import Principals from "./Principals.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import Sources from "./Sources.svelte";
  import Tasks from "./Tasks.svelte";
  import Teams from "./Teams.svelte";
  import Vaults from "./Vaults.svelte";
  import { t } from "../../../lib/i18n.ts";

  let { tabId, section, id }: { tabId: string; section: AdminSection; id?: string } = $props();

  $effect(() => ws.setTitle(tabId, t("Console · {x}", { x: ADMIN_SECTIONS.find((s) => s.id === section)?.label ?? "" })));
  const go = (e: MouseEvent, s: AdminSection) => (e.preventDefault(), ws.open({ kind: "admin", section: s }, target(e)));
</script>

{#if !session.me?.isAdmin}
  <div class="empty"><h2>{t("Riservato agli amministratori")}</h2><p>{t("La console gestisce utenti, permessi e server.")}</p></div>
{:else}
  <div class="av">
    <nav class="sections" aria-label={t("Sezioni della console")}>
      <p class="cap">{t("Console")}</p>
      {#each ADMIN_SECTIONS as s (s.id)}
        <a href="#/admin/{s.id}" class:on={s.id === section} aria-current={s.id === section ? "page" : undefined} onclick={(e) => go(e, s.id)}>
          <Icon name={s.icon} size={16} />{s.label}
        </a>
      {/each}
      <p class="cap">{t("Altro")}</p>
      <a href="#/curatori" onclick={(e) => (e.preventDefault(), ws.open({ kind: "curator" }, target(e)))}><Icon name="hive" size={16} />{t("Coda dei curatori")}</a>
      <a href="#/notte" onclick={(e) => (e.preventDefault(), ws.open({ kind: "dream" }, target(e)))}><Icon name="moon" size={16} />{t("Ciclo notturno")}</a>
      <a href="#/dashboard/panoramica" onclick={(e) => (e.preventDefault(), ws.open({ kind: "dashboard", id: "panoramica" }, target(e)))}><Icon name="gauge" size={16} />{t("Dashboard")}</a>
    </nav>
    <div class="content">
      {#key section}
        {#if section === "utenti"}
          <Principals kind="user" selected={id} />
        {:else if section === "team"}
          <Teams selected={id} />
        {:else if section === "api"}
          <Principals kind="api" selected={id} />
        {:else if section === "vault"}
          <Vaults selected={id} />
        {:else if section === "permessi"}
          <Grants selected={id} />
        {:else if section === "sorgenti"}
          <Sources vault={id} />
        {:else if section === "import"}
          <Imports />
        {:else if section === "task"}
          <Tasks selected={id} />
        {:else if section === "modelli"}
          <Models />
        {:else if section === "audit"}
          <Audit principal={id} />
        {:else if section === "impostazioni"}
          <SettingsSection />
        {:else if section === "backup"}
          <Backup />
        {/if}
      {/key}
    </div>
  </div>
{/if}

<style>
  .av {
    min-height: 0;
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
  }
  .sections {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 1rem 0.6rem;
    border-right: 1px solid var(--line);
    overflow-y: auto;
  }
  .cap {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.8rem 0.6rem 0.35rem;
  }
  .cap:first-child {
    padding-top: 0;
  }
  .sections a {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.42rem 0.6rem;
    border-radius: var(--r-control);
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--fs-sm);
  }
  .sections a:hover {
    background: var(--ink-1);
    color: var(--text-main);
  }
  .sections a.on {
    background: var(--ink-2);
    color: var(--text-main);
    font-weight: 600;
  }
  .content {
    overflow-y: auto;
    min-height: 0;
    padding: 1.5rem 1.75rem 4rem;
  }
  @media (max-width: 760px) {
    .av {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .sections {
      flex-direction: row;
      overflow-x: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
      padding: 0.5rem;
    }
    .cap {
      display: none;
    }
    .sections a {
      white-space: nowrap;
    }
    .content {
      padding: 1rem;
    }
  }
</style>
