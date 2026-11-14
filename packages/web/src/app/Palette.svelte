<script lang="ts">
  // Ctrl+K command palette and Ctrl+O quick switcher (one dialog, two modes). In the switcher,
  // titles and aliases come from the server as you type; Enter opens, Ctrl+Enter opens in a
  // new tab, Shift+Enter in the other pane. With no match, the last row creates the page.
  import { tick } from "svelte";
  import { api, qs } from "../lib/api.ts";
  import { current } from "../lib/current.svelte.ts";
  import { typeLabel } from "../lib/format.ts";
  import { prefetch } from "../lib/pages.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import { applyTheme, THEMES, THEME_LABELS } from "../lib/theme.ts";
  import type { Suggestion } from "../lib/types.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { t } from "../lib/i18n.ts";

  interface Item {
    id: string;
    label: string;
    hint?: string;
    keys?: string;
    run: (where: "here" | "tab" | "split") => void;
  }

  let dialog: HTMLDialogElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let q = $state("");
  let sel = $state(0);
  let found = $state<Suggestion[]>([]);
  /** Query the current `found` list answers. Enter on a newer query waits for its answer. */
  let foundFor = $state<string | null>(null);
  let queued: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean } | null = null;
  const mode = $derived(ui.palette);

  $effect(() => {
    if (mode && dialog && !dialog.open) {
      q = "";
      sel = 0;
      found = [];
      foundFor = null;
      queued = null;
      dialog.showModal();
      void tick().then(() => input?.focus());
    } else if (!mode && dialog?.open) dialog.close();
  });

  const shown = $derived(current.byTab[ws.tab.id]?.page);

  const commands = $derived.by((): Item[] => {
    const list: Item[] = [
      { id: "open", label: t("Apri una pagina"), keys: t("Ctrl O"), run: () => ((ui.palette = "switcher"), (q = "")) },
      { id: "search", label: t("Cerca nella memoria"), keys: t("Ctrl Maiusc F"), run: (w) => ws.open({ kind: "search", q: "" }, w) },
      { id: "graph", label: t("Apri il grafo"), run: (w) => ws.open({ kind: "graph" }, w) },
      { id: "inbox", label: t("Apri l'inbox"), run: (w) => ws.open({ kind: "inbox", tab: "inbox" }, w) },
      { id: "review", label: t("Apri «Da rivedere»"), run: (w) => ws.open({ kind: "inbox", tab: "review" }, w) },
      { id: "agent", label: t("Cosa ha letto l'agente cloud"), run: (w) => ws.open({ kind: "agent" }, w) },
      { id: "curator", label: t("Coda dei curatori"), run: (w) => ws.open({ kind: "curator" }, w) },
      { id: "dream", label: t("Ciclo notturno: rapporti"), run: (w) => ws.open({ kind: "dream" }, w) },
      { id: "split", label: ws.panes.length === 2 ? t("Unisci i pannelli") : t("Dividi il pannello"), keys: t("Ctrl \\"), run: () => ws.toggleSplit() },
      { id: "newtab", label: t("Nuova scheda"), keys: t("Alt T"), run: () => ws.newTab() },
      { id: "left", label: ui.leftOpen ? t("Nascondi la barra laterale") : t("Mostra la barra laterale"), keys: t("Ctrl B"), run: () => (ui.leftOpen = !ui.leftOpen) },
      { id: "right", label: ui.rightOpen ? t("Nascondi il pannello dei dettagli") : t("Mostra il pannello dei dettagli"), keys: t("Ctrl Maiusc B"), run: () => (ui.rightOpen = !ui.rightOpen) },
      { id: "account", label: t("Il mio account"), run: (w) => ws.open({ kind: "account" }, w) },
      { id: "logout", label: t("Esci"), run: () => void session.logout() },
    ];
    if (session.writable.length) {
      list.unshift(
        { id: "new", label: t("Nuova pagina"), keys: t("Alt N"), run: () => (ui.newPage = {}) },
        { id: "upload", label: t("Carica documenti"), run: () => (ui.upload = {}) },
      );
    }
    if (shown) {
      if (shown.canWrite) list.unshift({ id: "edit", label: t("Modifica «{title}»", { title: shown.title }), keys: t("Ctrl E"), run: () => ws.replace({ kind: "page", id: shown.id, edit: true }) });
      list.push(
        { id: "hist", label: t("Storico di «{title}»", { title: shown.title }), run: (w) => ws.open({ kind: "history", id: shown.id }, w) },
        { id: "fav", label: ui.isFavorite(shown.id) ? t("Togli «{title}» dai preferiti", { title: shown.title }) : t("Aggiungi «{title}» ai preferiti", { title: shown.title }), run: () => ui.toggleFavorite({ id: shown.id, title: shown.title }) },
      );
    }
    for (const theme of THEMES) list.push({ id: `theme-${theme}`, label: t("Tema: {x}", { x: THEME_LABELS[theme] }), run: () => applyTheme(theme) });
    for (const v of session.vaults) list.push({ id: `vault-${v.id}`, label: t("Vault: {name}", { name: v.name }), hint: v.kind === "space" ? t("alveare") : t("cella"), run: () => session.selectVault(v.id) });
    return list;
  });

  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  /** Subsequence match: "nupa" finds "Nuova pagina". Earlier and contiguous hits rank first. */
  function score(label: string, query: string): number {
    const l = fold(label);
    const qq = fold(query);
    if (!qq) return 1;
    const i = l.indexOf(qq);
    if (i >= 0) return 100 - i;
    let pos = -1;
    let gaps = 0;
    for (const ch of qq) {
      const n = l.indexOf(ch, pos + 1);
      if (n < 0) return 0;
      gaps += n - pos - 1;
      pos = n;
    }
    return Math.max(1, 50 - gaps);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctl: AbortController | null = null;
  $effect(() => {
    if (mode !== "switcher") return;
    const query = q;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      ctl?.abort();
      ctl = new AbortController();
      try {
        found = await api.get<Suggestion[]>(`/api/suggest${qs({ q: query, limit: 20 })}`, { signal: ctl.signal });
        foundFor = query;
        sel = 0;
        if (queued) {
          const e = queued;
          queued = null;
          await tick();
          run(items[0], e);
        }
      } catch {
        /* keep the previous list */
      }
    }, query ? 70 : 0);
    return () => clearTimeout(timer);
  });

  const items = $derived.by((): Item[] => {
    if (mode === "commands") {
      return commands
        .map((c) => ({ c, s: score(c.label, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c);
    }
    const list: Item[] = found.map((s) => ({
      id: s.id,
      label: s.title,
      hint: `${s.alias ? `alias «${s.alias}» · ` : ""}${typeLabel(s.type)} · ${session.vaultName(s.vaultId)}`,
      run: (w) => ws.open({ kind: "page", id: s.id }, w),
    }));
    const text = q.trim();
    if (text && foundFor === q && session.writable.length && !found.some((s) => fold(s.title) === fold(text))) {
      list.push({ id: "create", label: t("Crea la pagina «{text}»", { text }), hint: t("nuova nota"), run: () => (ui.newPage = { title: text }) });
    }
    return list;
  });

  function run(item: Item | undefined, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    if (!item) return;
    const where = e.shiftKey ? "split" : e.ctrlKey || e.metaKey ? "tab" : "here";
    const keep = item.id === "open";
    if (!keep) ui.palette = null;
    item.run(where);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      document.getElementById(`pal-${sel}`)?.scrollIntoView({ block: "nearest" });
      const it = items[sel];
      if (mode === "switcher" && it && it.id !== "create") prefetch(it.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "switcher" && foundFor !== q) queued = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
      else run(items[sel], e);
    }
  }
</script>

<dialog class="modal palette" bind:this={dialog} onclose={() => (ui.palette = null)} onclick={(e) => e.target === dialog && (ui.palette = null)} aria-label={mode === "switcher" ? t("Apri una pagina") : t("Comandi")}>
  {#if mode}
    <div class="pal">
      <input
        bind:this={input}
        bind:value={q}
        class="q"
        placeholder={mode === "switcher" ? t("Titolo o alias della pagina…") : t("Scrivi un comando…")}
        oninput={() => (sel = 0)}
        onkeydown={onKey}
        role="combobox"
        aria-expanded="true"
        aria-controls="pal-list"
        aria-activedescendant={items.length ? `pal-${sel}` : undefined}
        autocomplete="off"
        spellcheck="false"
      />
      <ul id="pal-list" role="listbox" class="list">
        {#each items as it, i (it.id)}
          <li id="pal-{i}" role="option" aria-selected={i === sel}>
            <button tabindex="-1" class:sel={i === sel} onclick={(e) => run(it, e)} onmouseenter={() => (sel = i)}>
              <span class="l">{it.label}</span>
              {#if it.hint}<span class="h">{it.hint}</span>{/if}
              {#if it.keys}<kbd>{it.keys}</kbd>{/if}
            </button>
          </li>
        {:else}
          <li class="none">{mode === "switcher" ? (q ? t("Nessuna pagina con questo titolo.") : t("Scrivi per cercare tra i titoli.")) : t("Nessun comando.")}</li>
        {/each}
      </ul>
      <footer class="ft">
        <span><kbd>↑</kbd><kbd>↓</kbd> {t("scegli")}</span><span><kbd>Invio</kbd> {t("apri")}</span><span><kbd>Ctrl Invio</kbd> {t("nuova scheda")}</span><span><kbd>Maiusc Invio</kbd> {t("altro pannello")}</span><span><kbd>Esc</kbd> {t("chiudi")}</span>
      </footer>
    </div>
  {/if}
</dialog>

<style>
  .palette {
    margin-top: 12vh;
    max-width: min(40rem, calc(100vw - 2rem));
  }
  .pal {
    display: grid;
  }
  .q {
    width: 100%;
    padding: 0.95rem 1.1rem;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    font-size: var(--fs-lg);
    outline: none;
  }
  .list {
    list-style: none;
    max-height: 55vh;
    overflow-y: auto;
    padding: 0.35rem;
  }
  .list button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.7rem;
    border: 0;
    border-radius: 7px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .list button.sel {
    background: var(--ink-3);
  }
  .l {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 50%;
  }
  .none {
    padding: 1rem;
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
  .ft {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    padding: 0.5rem 0.9rem;
    border-top: 1px solid var(--line);
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .ft kbd {
    margin-right: 0.2rem;
  }
</style>
