<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import { loadAdmin, loadDashboard } from "../lib/lazy.ts";
  import { phaseLabel, working } from "../lib/working.svelte.ts";
  import { ws, type Pane } from "../lib/workspace.svelte.ts";
  import AccountView from "./views/AccountView.svelte";
  import AgentView from "./views/AgentView.svelte";
  import CuratorView from "./views/CuratorView.svelte";
  import DreamView from "./views/DreamView.svelte";
  import GraphView from "./views/GraphView.svelte";
  import HistoryView from "./views/HistoryView.svelte";
  import HomeView from "./views/HomeView.svelte";
  import InboxView from "./views/InboxView.svelte";
  import PageView from "./views/PageView.svelte";
  import SearchView from "./views/SearchView.svelte";
  import SourceView from "./views/SourceView.svelte";
  import { t } from "../lib/i18n.ts";

  let { pane, index }: { pane: Pane; index: number } = $props();
  const tab = $derived(pane.tabs[pane.active]);
  const focused = $derived(ws.focused === index);

  /** What the pipeline is doing for the document of a tab (or for the inbox), if anything. */
  function busyOf(v: (typeof pane.tabs)[number]["view"]): string | null {
    if (v.kind === "source") {
      const w = working.get(v.id);
      return w ? phaseLabel(w) : null;
    }
    if (v.kind === "inbox" && working.count) return t("{count} documenti in lavorazione", { count: working.count });
    return null;
  }

  function onTabKey(e: KeyboardEvent, i: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = (i + (e.key === "ArrowRight" ? 1 : -1) + pane.tabs.length) % pane.tabs.length;
      ws.activate(index, n);
      (e.currentTarget as HTMLElement).closest("[role=tablist]")?.querySelectorAll<HTMLElement>("[role=tab]")[n]?.focus();
    } else if (e.key === "Delete") {
      ws.close(index, i);
    }
  }
</script>

<section class="pane" class:focused aria-label={t("Pannello {x}", { x: index + 1 })} onfocusin={() => ws.focus(index)} onpointerdown={() => ws.focus(index)}>
  <header class="tabbar">
    <div class="nav">
      <button class="icon-btn" title={t("Indietro (Alt ←)")} aria-label={t("Indietro")} disabled={!tab?.back.length} onclick={() => (ws.focus(index), ws.back())}><Icon name="back" size={16} /></button>
      <button class="icon-btn" title={t("Avanti (Alt →)")} aria-label={t("Avanti")} disabled={!tab?.fwd.length} onclick={() => (ws.focus(index), ws.forward())}><Icon name="forward" size={16} /></button>
    </div>
    <div class="tabs">
      <!-- the tab list holds only tabs; the close buttons are a mouse shortcut (keyboard: Canc or Alt+W) -->
      <div class="tablist" role="tablist" aria-label={t("Schede")}>
        {#each pane.tabs as tab, i (tab.id)}
          {@const busy = busyOf(tab.view)}
          <div class="tab" class:active={i === pane.active} title={busy ? `${tab.title} · ${busy}` : tab.title} role="presentation">
            <button
              role="tab"
              class="tab-btn"
              aria-selected={i === pane.active}
              tabindex={i === pane.active ? 0 : -1}
              onclick={() => ws.activate(index, i)}
              onauxclick={(e) => e.button === 1 && ws.close(index, i)}
              onkeydown={(e) => onTabKey(e, i)}
              >{#if busy}<span class="busy" aria-hidden="true"></span><span class="visually-hidden">{busy}: </span>{/if}{tab.title}</button
            >
            <button class="x" aria-hidden="true" tabindex="-1" title={t("Chiudi (Alt W)")} onclick={() => ws.close(index, i)}><Icon name="close" size={12} /></button>
          </div>
        {/each}
      </div>
      <button class="icon-btn add" title={t("Nuova scheda (Alt T)")} aria-label={t("Nuova scheda")} onclick={() => (ws.focus(index), ws.newTab())}><Icon name="plus" size={15} /></button>
    </div>
    <button class="icon-btn" title={ws.panes.length === 2 ? t("Unisci i pannelli (Ctrl \\)") : t("Dividi il pannello (Ctrl \\)")} aria-label={t("Dividi o unisci i pannelli")} aria-pressed={ws.panes.length === 2} onclick={() => (ws.focus(index), ws.toggleSplit())}>
      <Icon name="split" size={16} />
    </button>
  </header>

  <div class="body">
    {#if tab}
      {#key tab.id}
        {@const v = tab.view}
        {#if v.kind === "page"}
          <PageView tabId={tab.id} id={v.id} anchor={v.anchor} edit={!!v.edit} paneIndex={index} />
        {:else if v.kind === "search"}
          <SearchView tabId={tab.id} q={v.q} />
        {:else if v.kind === "graph"}
          <GraphView />
        {:else if v.kind === "source"}
          <SourceView tabId={tab.id} id={v.id} chunk={v.chunk} />
        {:else if v.kind === "inbox"}
          <InboxView tab={v.tab ?? "inbox"} />
        {:else if v.kind === "agent"}
          <AgentView />
        {:else if v.kind === "history"}
          <HistoryView tabId={tab.id} id={v.id} />
        {:else if v.kind === "account"}
          <AccountView />
        {:else if v.kind === "curator"}
          <CuratorView />
        {:else if v.kind === "dream"}
          <DreamView />
        {:else if v.kind === "admin"}
          {#await loadAdmin()}<span class="skeleton pad"></span>{:then { default: AdminView }}<AdminView tabId={tab.id} section={v.section} id={v.id} />{/await}
        {:else if v.kind === "dashboard"}
          {#await loadDashboard()}<span class="skeleton pad"></span>{:then { default: DashboardView }}<DashboardView tabId={tab.id} id={v.id} />{/await}
        {:else}
          <HomeView />
        {/if}
      {/key}
    {/if}
  </div>
</section>

<style>
  .skeleton.pad {
    margin: 1.5rem;
    height: 50vh;
  }
  .pane {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--ink-0);
  }
  .tabbar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.4rem 0;
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--line);
    min-width: 0;
  }
  .nav {
    display: flex;
    padding-bottom: 0.3rem;
  }
  .nav .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
    background: none;
  }
  .tabs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tablist {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    min-width: 0;
  }
  .tab {
    display: flex;
    align-items: center;
    max-width: 14rem;
    min-width: 6rem;
    border-radius: 8px 8px 0 0;
    color: var(--text-muted);
    flex: 0 1 auto;
  }
  .tab:hover {
    background: var(--ink-2);
  }
  .tab.active {
    background: var(--ink-0);
    color: var(--text-main);
    box-shadow: 0 1px 0 var(--ink-0);
  }
  .pane:not(.focused) .tab.active {
    color: var(--text-muted);
  }
  .pane.focused .tab.active {
    box-shadow:
      inset 0 2px 0 var(--you),
      0 1px 0 var(--ink-0);
  }
  /* a document in the pipeline: a small turning ring before the title */
  .busy {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    margin-right: 0.4rem;
    vertical-align: -0.05rem;
    border-radius: 50%;
    border: 2px solid var(--busy);
    border-right-color: transparent;
    animation: turn 0.9s linear infinite;
  }
  @keyframes turn {
    to {
      transform: rotate(1turn);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy {
      animation: none;
      border-right-color: var(--busy);
    }
  }
  .tab-btn {
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.25rem 0.45rem 0.75rem;
    border: 0;
    background: none;
    cursor: pointer;
    font-size: var(--fs-sm);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .x {
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    margin-right: 0.3rem;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    opacity: 0;
  }
  .tab:hover .x,
  .tab.active .x,
  .x:focus-visible {
    opacity: 1;
  }
  .x:hover {
    background: var(--ink-3);
    color: var(--text-main);
  }
  .add {
    margin-bottom: 0.25rem;
    flex: none;
  }
  .tabbar > .icon-btn {
    margin-bottom: 0.3rem;
  }
  .body {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    display: grid;
  }
</style>
