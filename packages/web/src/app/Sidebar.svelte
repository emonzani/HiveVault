<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import ThemePicker from "../components/ThemePicker.svelte";
  import { api } from "../lib/api.ts";
  import { sourceEvents } from "../lib/events.svelte.ts";
  import { curatorCount } from "../lib/curator.svelte.ts";
  import { dec1, FOLDERS, folderLabel } from "../lib/format.ts";
  import { pageEvents, prefetch } from "../lib/pages.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import type { PageListItem, SourceRow, Vault } from "../lib/types.ts";
  import { target, ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import FolderTree from "./FolderTree.svelte";
  import { intlLocale, t } from "../lib/i18n.ts";

  let counts = $state<Record<string, number>>({});
  let open = $state<Record<string, boolean>>({});
  let recent = $state<PageListItem[]>([]);
  let review = $state(0);
  let inboxBusy = $state(0);
  let showRecent = $state(true);
  let allVaults = $state(false);
  let reload = $state(0);

  const vault = $derived(session.vault);

  // Hive levels (study: "Multi-level Hive Selector"): company spaces first, then teams,
  // projects, edge devices, personal cells. The level comes from the owner of the vault.
  const LEVELS = [
    { id: "space", label: t("Spazio aziendale"), icon: "hive" },
    { id: "team", label: t("Team"), icon: "graph" },
    { id: "project", label: t("Progetto"), icon: "task" },
    { id: "edge", label: t("Edge"), icon: "shield" },
    { id: "user", label: t("Personale"), icon: "user" },
    { id: "cell", label: t("Cella"), icon: "database" },
  ] as const;
  type Level = (typeof LEVELS)[number];
  function levelOf(v: Vault): Level {
    const kind = v.kind === "space" ? "space" : (v.owner?.split(":")[0] ?? "cell");
    return LEVELS.find((l) => l.id === kind) ?? LEVELS[LEVELS.length - 1]!;
  }
  const VAULTS_SHOWN = 7;
  const sortedVaults = $derived(
    [...session.vaults].sort((a, b) => LEVELS.indexOf(levelOf(a)) - LEVELS.indexOf(levelOf(b)) || a.name.localeCompare(b.name, intlLocale)),
  );
  // the active vault is always visible, also when the list is cut
  const shownVaults = $derived(
    allVaults || sortedVaults.length <= VAULTS_SHOWN + 1
      ? sortedVaults
      : sortedVaults.filter((v, i) => i < VAULTS_SHOWN || v.id === vault?.id),
  );
  const folders = $derived([
    ...FOLDERS.filter((f) => counts[f.id]),
    ...Object.keys(counts)
      .filter((k) => !FOLDERS.some((f) => f.id === k))
      .map((id) => ({ id, label: folderLabel(id), icon: "▫" })),
  ]);
  const activeId = $derived(ws.tab.view.kind === "page" ? ws.tab.view.id : null);

  async function loadCounts(id: string) {
    try {
      const rows = await api.get<{ folder: string; count: number }[]>(`/api/vaults/${encodeURIComponent(id)}/folders`);
      counts = Object.fromEntries(rows.map((r) => [r.folder, r.count]));
      try {
        open = JSON.parse(localStorage.getItem(`cb-open-${id}`) ?? "{}") as Record<string, boolean>;
      } catch {
        open = {};
      }
    } catch {
      counts = {};
    }
  }

  async function loadSide() {
    try {
      const [r, rv, ib] = await Promise.all([
        api.get<PageListItem[]>("/api/recent?limit=8"),
        api.get<SourceRow[]>("/api/review?limit=200"),
        api.get<SourceRow[]>("/api/inbox?limit=50&mine=true"),
      ]);
      recent = r;
      review = rv.length;
      inboxBusy = ib.filter((s) => ["stored", "parsed"].includes(s.status)).length;
    } catch {
      /* the sidebar stays usable without these lists */
    }
  }

  $effect(() => {
    if (vault) void loadCounts(vault.id);
  });
  // a save, a new page or a source event refreshes counters and the recent list
  $effect(() => {
    void pageEvents.saved;
    void sourceEvents.tick;
    const t = setTimeout(() => {
      void loadSide();
      void curatorCount.refresh();
      if (vault) void loadCounts(vault.id);
      reload++;
    }, pageEvents.saved || sourceEvents.tick ? 800 : 0);
    return () => clearTimeout(t);
  });

  function toggle(f: string) {
    open[f] = !open[f];
    try {
      localStorage.setItem(`cb-open-${vault!.id}`, JSON.stringify(open));
    } catch {
      /* ignore */
    }
  }

  const permLabel: Record<string, string> = { read: t("lettura"), write: t("scrittura"), curate: t("cura"), admin: t("gestione") };
  const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${dec1(n / 1000)}k` : String(n));
</script>

<aside class="sidebar" aria-label={t("Navigazione del vault")}>
  <button class="search" onclick={(e) => ws.open({ kind: "search", q: "" }, target(e))}>
    <Icon name="search" size={15} /><span>{t("Cerca")}</span><kbd>Ctrl Maiusc F</kbd>
  </button>

  <nav class="scroll">
    <p class="eyebrow sec" id="hive-vaults">{t("Vault dell'alveare")}</p>
    <ul class="vaults" aria-labelledby="hive-vaults">
      {#each shownVaults as v (v.id)}
        {@const lv = levelOf(v)}
        <li>
          <button
            class="vault-row {lv.id}"
            aria-current={v.id === vault?.id ? "true" : undefined}
            title="{lv.label} · {permLabel[v.permission]}"
            onclick={() => session.selectVault(v.id)}
          >
            <span class="vi" aria-hidden="true"><Icon name={lv.icon} size={14} /></span>
            <span class="vn">{v.name}</span>
            <span class="vc tabular">{v.kind === "cell" && lv.id !== "cell" ? lv.label : compact(v.pages ?? 0)}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if sortedVaults.length > VAULTS_SHOWN + 1}
      <button class="more" aria-expanded={allVaults} onclick={() => (allVaults = !allVaults)}>
        {allVaults ? t("Mostra meno") : t("Altri {x} vault", { x: sortedVaults.length - shownVaults.length })}
      </button>
    {/if}

    <p class="eyebrow sec">{t("Lavoro")}</p>
    <a class="nav" class:active={ws.tab.view.kind === "inbox" && ws.tab.view.tab !== "review"} href="#/inbox" onclick={(e) => (e.preventDefault(), ws.open({ kind: "inbox", tab: "inbox" }, target(e)))}>
      <Icon name="inbox" size={15} /><span>{t("Inbox")}</span>
      {#if inboxBusy}<span class="badge busy" title={t("Documenti in elaborazione")}>{inboxBusy}</span>{/if}
    </a>
    <a class="nav" class:active={ws.tab.view.kind === "inbox" && ws.tab.view.tab === "review"} href="#/da-rivedere" onclick={(e) => (e.preventDefault(), ws.open({ kind: "inbox", tab: "review" }, target(e)))}>
      <Icon name="alert" size={15} /><span>{t("Da rivedere")}</span>
      {#if review}<span class="badge you">{review}</span>{/if}
    </a>

    {#if curatorCount.curates}
      <a class="nav" class:active={ws.tab.view.kind === "curator"} href="#/curatori" onclick={(e) => (e.preventDefault(), ws.open({ kind: "curator" }, target(e)))}>
        <Icon name="check" size={15} /><span>{t("Coda dei curatori")}</span>
        {#if curatorCount.total}<span class="badge you">{curatorCount.total}</span>{/if}
      </a>
    {/if}
    <a class="nav" class:active={ws.tab.view.kind === "dream"} href="#/notte" onclick={(e) => (e.preventDefault(), ws.open({ kind: "dream" }, target(e)))}>
      <Icon name="moon" size={15} /><span>{t("Ciclo notturno")}</span>
    </a>

    {#if ui.favorites.length}
      <p class="eyebrow sec">{t("Preferiti")}</p>
      {#each ui.favorites as f (f.id)}
        <a class="leaf" class:active={f.id === activeId} href="#/p/{f.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: f.id }, target(e)))} onmouseenter={() => prefetch(f.id)}>
          <span class="star" aria-hidden="true">★</span>{f.title}
        </a>
      {/each}
    {/if}

    {#if recent.length}
      <button class="eyebrow sec sec-btn" aria-expanded={showRecent} onclick={() => (showRecent = !showRecent)}>{t("Recenti")}</button>
      {#if showRecent}
        {#each recent as p (p.id)}
          <a class="leaf" class:active={p.id === activeId} href="#/p/{p.id}" title="{p.title} · {session.vaultName(p.vaultId ?? '')}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: p.id }, target(e)))} onmouseenter={() => prefetch(p.id)}>
            {p.title}
          </a>
        {/each}
      {/if}
    {/if}

    <p class="eyebrow sec">{vault?.name ?? t("Vault")}</p>
    {#if vault && !folders.length}
      <p class="none">{t("Ancora nessuna pagina. Carica un documento o crea una nota.")}</p>
    {/if}
    {#each folders as f (f.id)}
      <button class="folder" aria-expanded={!!open[f.id]} onclick={() => toggle(f.id)}>
        <span class="caret" class:open={open[f.id]} aria-hidden="true"><Icon name="chevron" size={12} /></span>
        <span class="fi" aria-hidden="true">{f.icon}</span>
        <span class="fl">{f.label}</span>
        <span class="count tabular">{counts[f.id]?.toLocaleString(intlLocale)}</span>
      </button>
      {#if open[f.id] && vault}
        <FolderTree vaultId={vault.id} folder={f.id} count={counts[f.id] ?? 0} {reload} />
      {/if}
    {/each}
  </nav>

  <footer class="foot">
    <ThemePicker />
  </footer>
</aside>

<style>
  .sidebar {
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--line);
  }
  .vaults {
    list-style: none;
    display: grid;
    gap: 1px;
  }
  .vault-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-height: 30px;
    padding: 0 0.55rem;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-main);
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .vault-row:hover {
    background: var(--ink-2);
  }
  .vault-row[aria-current="true"] {
    background: var(--you-soft);
    box-shadow: inset 2px 0 0 var(--you);
    font-weight: 600;
  }
  .vi {
    display: inline-grid;
    color: var(--text-muted);
  }
  .vault-row.space .vi {
    color: var(--busy-ink);
  }
  .vault-row.team .vi,
  .vault-row.project .vi {
    color: var(--idle-ink);
  }
  .vault-row.edge .vi,
  .vault-row.user .vi {
    color: var(--you-ink);
  }
  .vn {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vc {
    font-size: 0.6875rem;
    color: var(--text-dim);
  }
  .vault-row.edge .vc,
  .vault-row.user .vc {
    color: var(--you-ink);
  }
  .more {
    margin: 0.15rem 0 0;
    padding: 0.15rem 0.55rem;
    border: 0;
    background: none;
    color: var(--text-dim);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-main);
  }
  .search {
    margin: 0.6rem 0.55rem 0.25rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--ink-0);
    color: var(--text-dim);
    cursor: pointer;
    font-size: var(--fs-sm);
  }
  .search span {
    flex: 1;
    text-align: left;
  }
  .search:hover {
    color: var(--text-main);
    border-color: var(--line-strong);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.1rem 0.55rem 1rem;
  }
  .nav,
  .leaf,
  .folder {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 30px;
    padding: 0 0.55rem;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-align: left;
  }
  .nav:hover,
  .leaf:hover,
  .folder:hover {
    background: var(--ink-2);
    color: var(--text-main);
  }
  .nav.active,
  .leaf.active {
    background: var(--ink-3);
    color: var(--text-main);
    box-shadow: inset 2px 0 0 var(--you);
  }
  .nav span:not(.badge) {
    flex: 1;
  }
  .leaf {
    display: block;
    line-height: 28px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .star {
    color: var(--you);
    margin-right: 0.4rem;
    font-size: 0.75em;
  }
  .badge {
    min-width: 1.3rem;
    padding: 0 0.35rem;
    border-radius: var(--r-pill);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-align: center;
    line-height: 1.15rem;
  }
  .badge::before {
    display: none;
  }
  .badge.you {
    background: var(--you-soft);
    color: var(--you-ink);
    border-color: transparent;
  }
  .badge.busy {
    background: var(--busy-soft);
    color: var(--busy-ink);
  }
  .sec {
    display: block;
    margin: 1rem 0 0.3rem;
    padding: 0 0.55rem;
    color: var(--text-dim);
  }
  .scroll > .sec:first-child {
    margin-top: 0.6rem;
  }
  .sec-btn {
    min-height: 24px;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }
  .sec-btn:hover {
    color: var(--text-muted);
  }
  .caret {
    display: inline-grid;
    color: var(--text-dim);
    transition: transform var(--transition-fast);
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .fi {
    color: var(--text-dim);
    width: 0.9rem;
    text-align: center;
    font-size: 0.8em;
  }
  .fl {
    flex: 1;
  }
  .count {
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
  .none {
    padding: 0.3rem 0.55rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .foot {
    padding: 0.55rem 0.85rem;
    border-top: 1px solid var(--line);
  }
</style>
