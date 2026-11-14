<script lang="ts">
  // Inbox and document pipeline: the latest
  // documents with their live status (server-sent events), counters that filter the list and a
  // filter by vault. The selected document shows in the right panel (SourceInspector).
  // "Da rivedere": documents that failed, are not supported or need OCR.
  import { untrack } from "svelte";
  import { phaseLabel, working } from "../../lib/working.svelte.ts";
  import Button from "../../components/Button.svelte";
  import Icon from "../../components/Icon.svelte";
  import { api, qs } from "../../lib/api.ts";
  import { sourceEvents } from "../../lib/events.svelte.ts";
  import { nf, SOURCE_STATUS, WARNING_LABEL, when } from "../../lib/format.ts";
  import { session } from "../../lib/session.svelte.ts";
  import { inspect } from "../../lib/inspect.svelte.ts";
  import type { SourceRow } from "../../lib/types.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";
  import { tablist } from "../../lib/tablist.ts";

  let { tab }: { tab: "inbox" | "review" } = $props();

  let rows = $state<SourceRow[] | null>(null);
  let reviewCount = $state<number | null>(null);
  let mine = $state(false);
  let error = $state("");
  type Filter = "all" | "work" | "compiled" | "search";
  let filter = $state<Filter>("all");
  let vaultFilter = $state<string | null>(null);
  let selected = $state<string | null>(null);
  const tabId = ws.tab.id;

  async function load() {
    try {
      const [list, review] = await Promise.all([
        api.get<SourceRow[]>(tab === "review" ? "/api/review?limit=200" : `/api/inbox${qs({ limit: 200, mine: mine || undefined })}`),
        tab === "review" ? Promise.resolve(null) : api.get<SourceRow[]>("/api/review?limit=200").catch(() => null),
      ]);
      rows = list;
      reviewCount = tab === "review" ? list.length : (review?.length ?? null);
      error = "";
      if (!selected || !list.some((r) => r.id === selected)) selected = list[0]?.id ?? null;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void tab;
    void mine;
    rows = null;
    filter = "all";
    vaultFilter = null;
    untrack(() => void load());
  });

  // live updates: patch the row at once, reload the list after a burst of events
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void sourceEvents.tick;
    untrack(() => {
      if (!rows) return;
      for (const r of rows) {
        const e = sourceEvents.status[r.id];
        if (e) (r.status = e.status), (r.level = e.level);
      }
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    });
    return () => clearTimeout(timer);
  });

  // the panel reviewed, deleted or replaced a source: read the list again
  $effect(() => {
    if (!inspect.changed) return;
    untrack(() => {
      if (inspect.selectNext !== undefined) selected = inspect.selectNext;
      inspect.selectNext = undefined;
      void load();
    });
  });

  // the right panel of the shell shows the selected document
  $effect(() => {
    inspect.sourceByTab[tabId] = selected;
    return () => (inspect.sourceByTab[tabId] = null);
  });

  const isWorking = (r: SourceRow) => working.has(r.id) || r.status === "stored" || r.status === "parsed";
  const counts = $derived({
    work: rows?.filter(isWorking).length ?? 0,
    compiled: rows?.filter((r) => r.level >= 3).length ?? 0,
    search: rows?.filter((r) => r.level === 1 || r.level === 2).length ?? 0,
  });
  const byVault = $derived(
    Object.entries((rows ?? []).reduce<Record<string, number>>((m, r) => ((m[r.vaultId] = (m[r.vaultId] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
  );
  const shown = $derived(
    (rows ?? []).filter(
      (r) =>
        (!vaultFilter || r.vaultId === vaultFilter) &&
        (filter === "all" || (filter === "work" ? isWorking(r) : filter === "compiled" ? r.level >= 3 : r.level === 1 || r.level === 2)),
    ),
  );
  const tokens = $derived(shown.reduce((n, r) => n + (r.textTokens ?? 0), 0));
  const toggle = (f: Filter) => (filter = filter === f ? "all" : f);

  const reason = (r: SourceRow) =>
    r.status === "failed" ? (r.error ?? t("Errore di elaborazione")) : r.status === "unsupported" ? t("Formato non supportato") : (r.warnings ?? []).map((w) => WARNING_LABEL[w] ?? w).join(" · ");

  // the review actions (reviewed, change link, delete) are in the right panel
  const review = (r: SourceRow) => ((selected = r.id), (ui.rightOpen = true));

</script>

<div class="iv">
  <header class="head">
    <div class="title">
      <p class="eyebrow you">{t("Pipeline dei documenti")}</p>
      <h1>{tab === "review" ? t("Da rivedere") : t("Inbox")}</h1>
    </div>
    <div class="tabs" role="tablist" use:tablist aria-label={t("Elenchi")}>
      <button role="tab" aria-selected={tab === "inbox"} onclick={() => ws.replace({ kind: "inbox", tab: "inbox" })}>{t("Inbox")}</button>
      <button role="tab" aria-selected={tab === "review"} onclick={() => ws.replace({ kind: "inbox", tab: "review" })}>
        {t("Da rivedere")}{#if reviewCount}<span class="n mono">{reviewCount}</span>{/if}
      </button>
    </div>
    <span class="grow"></span>
    <span class="live" title={sourceEvents.connected ? t("Aggiornamenti in tempo reale attivi") : t("Aggiornamenti in tempo reale non connessi")}>
      <span class="dot {sourceEvents.connected ? 'busy' : 'dim'}"></span>{sourceEvents.connected ? t("in tempo reale") : t("non connesso")}
    </span>
    {#if session.writable.length}<Button size="sm" variant="primary" onclick={() => (ui.upload = {})}><Icon name="upload" size={14} />{t("Carica documenti")}</Button>{/if}
  </header>

  <div class="main">
    {#if tab === "inbox" && rows}
      <div class="kpis" role="group" aria-label={t("Filtra per stato")}>
        <button class="kpi" aria-pressed={filter === "work"} onclick={() => toggle("work")}>
          <span class="eyebrow">{t("In lavorazione")}</span>
          <span class="kpi-icon" aria-hidden="true"><Icon name="refresh" size={16} /></span>
          <span class="kpi-value">{counts.work}<span class="kpi-note">{t("documenti")}</span></span>
        </button>
        <button class="kpi busy" aria-pressed={filter === "compiled"} onclick={() => toggle("compiled")}>
          <span class="eyebrow">{t("Compilati per l'agente cloud")}</span>
          <span class="kpi-icon" aria-hidden="true"><Icon name="check" size={16} /></span>
          <span class="kpi-value">{counts.compiled}<span class="kpi-note">{t("pagine I3")}</span></span>
        </button>
        <button class="kpi idle" aria-pressed={filter === "search"} onclick={() => toggle("search")}>
          <span class="eyebrow">{t("Cercabili")}</span>
          <span class="kpi-icon" aria-hidden="true"><Icon name="search" size={16} /></span>
          <span class="kpi-value">{counts.search}<span class="kpi-note">I1 · I2</span></span>
        </button>
        <button class="kpi you" onclick={() => ws.replace({ kind: "inbox", tab: "review" })}>
          <span class="eyebrow">{t("Da rivedere")}</span>
          <span class="kpi-icon" aria-hidden="true"><Icon name="alert" size={16} /></span>
          <span class="kpi-value">{reviewCount ?? "–"}<span class="kpi-note">{t("azione richiesta")}</span></span>
        </button>
      </div>
    {/if}

    {#if rows && rows.length}
      <div class="filters">
        <div class="chips" role="group" aria-label={t("Filtra per vault")}>
          <button class="chip" aria-pressed={!vaultFilter} onclick={() => (vaultFilter = null)}>{t("Tutti i vault")} <span class="n">{rows.length}</span></button>
          {#each byVault as [id, n] (id)}
            <button class="chip" aria-pressed={vaultFilter === id} onclick={() => (vaultFilter = vaultFilter === id ? null : id)}>{session.vaultName(id)} <span class="n">{n}</span></button>
          {/each}
        </div>
        {#if tab === "inbox"}<label class="mine"><input type="checkbox" bind:checked={mine} /> {t("Solo i miei caricamenti")}</label>{/if}
      </div>
    {/if}

    <div class="list">
      {#if error}
        <p class="notice error">{error}</p>
      {:else if !rows}
        {#each [1, 2, 3, 4] as i (i)}<span class="skeleton" style="height:2.4rem;margin:0.4rem 0"></span>{/each}
      {:else if !rows.length}
        <div class="empty">
          {#if tab === "review"}
            <h2>{t("Niente da rivedere")}</h2>
            <p>{t("Tutti i documenti sono stati letti senza problemi.")}</p>
          {:else}
            <h2>{t("L'inbox è vuota")}</h2>
            <p>{t("Trascina dei file in questa finestra o usa «Carica documenti». I file restano sul server.")}</p>
          {/if}
        </div>
      {:else}
        <div class="table-card">
          <div class="table-head">
            <h2>{t("Coda di elaborazione")}</h2>
            <span class="dim tabular">{t("{n} di {n2} documenti", { n: shown.length, n2: rows.length })}</span>
          </div>
          <div class="table-scroll">
          <table>
            <thead>
              <tr><th class="num">#</th><th>{t("Documento")}</th><th>{t("Stato")}</th><th>{t("Vault")}</th><th class="r">{t("Token")}</th><th class="r">{t("Caricato")}</th>{#if tab === "review"}<th></th>{/if}</tr>
            </thead>
            <tbody>
              {#each shown as r, i (r.id)}
                {@const st = SOURCE_STATUS[r.status] ?? { label: r.status, tone: "dim" }}
                {@const w = working.get(r.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (the details button is the keyboard path) -->
                <tr class:sel={r.id === selected} onclick={(e) => (e.target as HTMLElement).closest("a, button") || (selected = r.id)}>
                  <td class="num mono dim">{String(i + 1).padStart(2, "0")}</td>
                  <td class="name">
                    <a href="#/sorgente/{r.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "source", id: r.id }, target(e)))}>{r.title ?? r.name}</a>
                    <span class="file mono">{r.name}{#if tab === "review"} · <span class="why">{reason(r)}</span>{/if}</span>
                  </td>
                  <td>
                    <span class="badge {w ? 'warn' : st.tone === 'dim' ? '' : st.tone}" title={w ? phaseLabel(w) : ""}>{st.label}{#if w} {t("· in lavorazione")}{/if}</span>
                  </td>
                  <td class="dim vault">{session.vaultName(r.vaultId)}</td>
                  <td class="r mono dim">{r.textTokens ? nf.format(r.textTokens) : "–"}</td>
                  <td class="r dim">{when(r.createdAt)}</td>
                  {#if tab === "review"}
                    <td class="r"><Button size="sm" variant="quiet" aria-label={t("Rivedi {x}", { x: r.title ?? r.name })} onclick={() => review(r)}>{t("Rivedi")}</Button></td>
                  {/if}
                  <td class="pick">
                    <button class="icon-btn" aria-label={t("Dettagli di {x}", { x: r.title ?? r.name })} aria-pressed={r.id === selected} onclick={() => ((selected = r.id), (ui.rightOpen = true))}><Icon name="props" size={14} /></button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          </div>
          <div class="table-foot dim tabular">{t("Token del testo nei documenti mostrati: {tokens}", { tokens: nf.format(tokens) })}</div>
        </div>
      {/if}
    </div>
  </div>

</div>

<style>
  .iv {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .head {
    grid-column: 1 / -1;
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    padding: 1rem 1.25rem 0.85rem;
    border-bottom: 1px solid var(--line);
  }
  .title h1 {
    font-size: var(--fs-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.2rem;
    border-radius: var(--r-control);
    background: var(--ink-2);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.75rem;
    border: 0;
    border-radius: var(--r-control);
    background: none;
    cursor: pointer;
    font-weight: 600;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .tabs button[aria-selected="true"] {
    background: var(--ink-1);
    color: var(--text-main);
    box-shadow: var(--shadow-subtle);
  }
  .tabs .n {
    font-size: 0.6875rem;
    color: var(--you-ink);
  }
  .grow {
    flex: 1;
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .main {
    min-height: 0;
    overflow: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 0.9rem;
    padding: 1rem 1.25rem 3rem;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    justify-content: space-between;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .mine {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .table-card {
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
    overflow: hidden;
  }
  .table-scroll {
    overflow-x: auto;
  }
  .table-scroll table {
    min-width: 44rem;
  }
  .table-head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.7rem 0.9rem;
    border-bottom: 1px solid var(--line);
  }
  .table-head h2 {
    font-size: var(--fs-md);
  }
  .table-head .tabular {
    font-size: var(--fs-xs);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  th {
    text-align: left;
    font-size: 0.6875rem;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--line);
    background: var(--ink-2);
    position: sticky;
    top: 0;
  }
  td {
    padding: 0.45rem 0.6rem;
    height: 2.375rem;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  tbody tr {
    cursor: default;
  }
  tbody tr:hover {
    background: var(--ink-2);
  }
  tr.sel {
    background: var(--you-soft);
    box-shadow: inset 2px 0 0 var(--you);
  }
  @media (max-width: 760px) {
    th.num,
    td.num {
      display: none;
    }
    th:nth-child(2),
    td.name {
      position: sticky;
      left: 0;
      z-index: 1;
      min-width: 10.5rem;
      max-width: 13rem;
      background: var(--ink-1);
      box-shadow: inset -1px 0 0 var(--line);
    }
    th:nth-child(2) {
      background: var(--ink-2);
    }
    tbody tr:hover td.name {
      background: var(--ink-2);
    }
    /* the tint of the selected row over an opaque base: the scrolled cells do not show through */
    tr.sel td.name {
      background: linear-gradient(var(--you-soft), var(--you-soft)), var(--ink-1);
    }
    .table-scroll table {
      min-width: 36rem;
    }
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  .num {
    width: 2.5rem;
    font-size: 0.75rem;
  }
  .r {
    text-align: right;
    white-space: nowrap;
  }
  td.r.mono {
    font-size: 0.75rem;
  }
  .name a {
    color: var(--text-main);
    font-weight: 600;
    text-decoration: none;
  }
  .name a:hover {
    text-decoration: underline;
  }
  .file {
    display: block;
    font-size: 0.6875rem;
    color: var(--text-dim);
    margin-top: 0.1rem;
    overflow-wrap: anywhere;
  }
  .why {
    font-family: var(--font-sans);
    color: var(--warn-ink);
  }
  .vault {
    white-space: nowrap;
  }
  .pick {
    width: 2.4rem;
    padding: 0 0.3rem;
  }
  .table-foot {
    padding: 0.55rem 0.9rem;
    border-top: 1px solid var(--line);
    font-size: 0.75rem;
    background: var(--ink-2);
  }
</style>
