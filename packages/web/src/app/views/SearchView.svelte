<script lang="ts">
  // Faceted search (plan §9.2): vault and type filters run on the server (before ranking,
  // invariant 6); kind and level facets refine the returned hits. The preview on the right
  // shows the matching passages; ↑/↓ move, Enter opens, Ctrl+Enter opens in a new tab.
  import { onMount, untrack } from "svelte";
  import ClassTag from "../../components/ClassTag.svelte";
  import VaultFilter from "../../components/VaultFilter.svelte";
  import { api } from "../../lib/api.ts";
  import { classificationName, FOLDERS, LEVEL_HINT, LEVEL_SHORT, nf, typeLabel } from "../../lib/format.ts";
  import { renderMarkdown, stripHead } from "../../lib/markdown.ts";
  import { previewCache, prefetch } from "../../lib/pages.svelte.ts";
  import { session } from "../../lib/session.svelte.ts";
  import type { ReadResult, SearchHit, SearchResult } from "../../lib/types.ts";
  import { target } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t, tHtml } from "../../lib/i18n.ts";

  let { tabId, q }: { tabId: string; q: string } = $props();

  let query = $state(untrack(() => q));
  let vaults = $state<string[]>([]);
  let folders = $state<string[]>([]);
  let kinds = $state<string[]>([]);
  let levels = $state<string[]>([]);
  let result = $state<SearchResult | null>(null);
  let loading = $state(false);
  let error = $state("");
  let sel = $state(0);
  let preview = $state<ReadResult | null>(null);
  let input: HTMLInputElement | undefined = $state();
  let listEl: HTMLOListElement | undefined = $state();

  const hits = $derived((result?.hits ?? []).filter((h) => (!kinds.length || kinds.includes(h.kind)) && (!levels.length || levels.includes(h.level))));
  const facet = (key: (h: SearchHit) => string) => {
    const m = new Map<string, number>();
    for (const h of result?.hits ?? []) m.set(key(h), (m.get(key(h)) ?? 0) + 1);
    return m;
  };
  const byKind = $derived(facet((h) => h.kind));
  const byLevel = $derived(facet((h) => h.level));
  const byVault = $derived(facet((h) => h.vaultId));
  const current = $derived(hits[Math.min(sel, hits.length - 1)]);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctl: AbortController | null = null;
  async function run() {
    const text = query.trim();
    ctl?.abort();
    if (!text) {
      result = null;
      return;
    }
    ctl = new AbortController();
    loading = true;
    error = "";
    try {
      result = await api.post<SearchResult>(
        "/api/search",
        { query: text, limit: 50, ...(vaults.length ? { vaults } : {}), ...(folders.length ? { types: folders } : {}) },
        { signal: ctl.signal },
      );
      sel = 0;
      ws.setTitle(tabId, t("Cerca: {text}", { text }));
    } catch (e) {
      if ((e as Error).name !== "AbortError") error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void query;
    void vaults.join();
    void folders.join();
    clearTimeout(timer);
    timer = setTimeout(() => {
      untrack(() => {
        if (ws.tab.view.kind === "search" && ws.tab.view.q !== query.trim()) ws.replace({ kind: "search", q: query.trim() });
        void run();
      });
    }, 220);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const h = current;
    preview = null;
    if (h?.kind !== "page") return;
    const cached = previewCache.peek(h.id);
    if (cached) preview = cached;
    else previewCache.get(h.id).then((p) => current?.id === h.id && (preview = p), () => {});
  });

  onMount(() => input?.focus());

  function open(h: SearchHit, e: MouseEvent | KeyboardEvent) {
    const where = e instanceof KeyboardEvent ? (e.ctrlKey || e.metaKey ? "tab" : e.shiftKey ? "split" : "here") : target(e);
    if (h.kind === "page") ws.open({ kind: "page", id: h.id }, where);
    else ws.open({ kind: "source", id: h.id, ...(h.chunks[0] ? { chunk: h.chunks[0].id } : {}) }, where);
  }

  function onKey(e: KeyboardEvent) {
    if (!hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
      listEl?.children[sel]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      open(current, e);
    }
  }

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  /**
   * Server snippet → safe HTML: the text is escaped, the terms the server marked «like this»
   * become <mark>, Markdown noise (citations, wikilink brackets, bold) is dropped.
   */
  function marked(snippet: string): string {
    const clean = snippet
      .replace(/\s?\^\[[^\]\n]*\]/g, "")
      .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, d?: string) => d ?? t)
      .replace(/\*\*|__/g, "")
      .replace(/(^|\s)>\s?(\[![a-z-]+\][+-]?\s*)?/gi, "$1")
      .replace(/(^|\s)#{1,6}\s/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return esc(clean).replace(/«([^«»]*)»/g, "<mark class=\"hl\">$1</mark>");
  }

  const previewHtml = $derived(preview ? renderMarkdown(stripHead(preview.content)) : "");
</script>

<div class="sv">
  <header class="top">
    <label class="box">
      <span class="visually-hidden">{t("Cerca nella memoria")}</span>
      <input
        bind:this={input}
        bind:value={query}
        data-search-input
        type="search"
        class="input"
        placeholder={t("Cerca in tutte le memorie a cui hai accesso: persone, clienti, decisioni, documenti…")}
        onkeydown={onKey}
        aria-controls="results-{tabId}"
        autocomplete="off"
      />
    </label>
    <div class="facets">
      <VaultFilter bind:selected={vaults} vaults={session.vaults} count={(id) => byVault.get(id)} />
      <div class="grp" role="group" aria-label={t("Tipo di pagina")}>
        {#each FOLDERS as f (f.id)}
          <button class="chip" aria-pressed={folders.includes(f.id)} onclick={() => (folders = toggle(folders, f.id))}>{f.label}</button>
        {/each}
      </div>
      <div class="grp" role="group" aria-label={t("Genere e livello")}>
        <button class="chip" aria-pressed={kinds.includes("page")} onclick={() => (kinds = toggle(kinds, "page"))}>{t("Pagine")}<span class="n">{byKind.get("page") ?? 0}</span></button>
        <button class="chip" aria-pressed={kinds.includes("source")} onclick={() => (kinds = toggle(kinds, "source"))}>{t("Documenti")}<span class="n">{byKind.get("source") ?? 0}</span></button>
        {#each ["I3", "I2", "I1"] as l (l)}
          <button class="chip" aria-pressed={levels.includes(l)} title={LEVEL_HINT[l]} onclick={() => (levels = toggle(levels, l))}><span class="lvl {l}">{l}</span>{LEVEL_SHORT[l]}<span class="n">{byLevel.get(l) ?? 0}</span></button>
        {/each}
      </div>
    </div>
    {#if result}
      <p class="meta" aria-live="polite">
        {t("{n} risultati · {tookMs} ms{x}", { n: hits.length, tookMs: Math.round(result.tookMs), x: result.cached ? t(" · dalla cache") : "" })}
        {#if result.degraded.includes("vector")} · <span class="warn">{t("ricerca per significato non disponibile ora: solo parole chiave")}</span>{/if}
      </p>
    {/if}
  </header>

  <div class="split">
    <ol class="results" id="results-{tabId}" bind:this={listEl} aria-label={t("Risultati")} aria-busy={loading}>
      {#if error}
        <li class="msg err">{error}</li>
      {:else if !query.trim()}
        <li class="msg">
          <p>{t("Scrivi una domanda o delle parole chiave. La ricerca unisce testo, significato e titoli e rispetta i tuoi permessi.")}</p>
          <p class="dim">{@html tHtml("Suggerimento: [↑] [↓] per scorrere, [Invio] per aprire, [Ctrl Invio] in una nuova scheda.")}</p>
        </li>
      {:else if result && !hits.length}
        <li class="msg">{t("Nessun risultato. Prova con parole diverse o togli qualche filtro.")}</li>
      {/if}
      {#each hits as h, i (h.kind + h.id)}
        <li>
          <button class="hit" class:sel={i === sel} onclick={(e) => open(h, e)} onmouseenter={() => ((sel = i), h.kind === "page" && prefetch(h.id))} onfocus={() => (sel = i)}>
            <span class="hh">
              <span class="ht">{h.title}</span>
              <span class="lvl {h.level}" title={LEVEL_HINT[h.level]}>{h.level}</span>
            </span>
            {#if h.chunks[0]}<span class="snip">{@html marked(h.chunks[0].snippet)}</span>{:else if h.tldr}<span class="snip">{h.tldr}</span>{/if}
            <span class="hm">
              <span>{h.kind === "page" ? typeLabel(h.type) : t("Documento")}</span>
              <span>{session.vaultName(h.vaultId)}</span>
              <span class="tabular">{t("{tokens} token", { tokens: nf.format(h.tokens) })}</span>
            </span>
          </button>
        </li>
      {/each}
    </ol>

    <aside class="preview" aria-label={t("Anteprima")}>
      {#if current}
        <div class="ph">
          <h2>{current.title}</h2>
          <ClassTag level={classificationName(current.classification)} />
        </div>
        <p class="dim small">{t("{x} · {vaultId} · cita come", { x: current.kind === "page" ? typeLabel(current.type) : t("Documento"), vaultId: session.vaultName(current.vaultId) })} <span class="mono">{current.cite}</span></p>
        {#if current.chunks.length}
          <div class="passages">
            {#each current.chunks.slice(0, 3) as c (c.id)}
              <blockquote class="prov-human">{#if c.heading}<span class="hd">{c.heading}</span>{/if}{@html marked(c.snippet)}</blockquote>
            {/each}
          </div>
        {/if}
        {#if current.kind === "page"}
          {#if preview}
            {#if preview.tldr}<p class="tldr">{preview.tldr}</p>{/if}
            <div class="md mini">{@html previewHtml}</div>
          {:else}
            <span class="skeleton" style="height:6rem"></span>
          {/if}
        {:else}
          <p class="dim small">{t("Apri il documento per vedere il testo estratto accanto all'originale.")}</p>
        {/if}
      {:else}
        <p class="dim small">{t("L'anteprima del risultato selezionato appare qui.")}</p>
      {/if}
    </aside>
  </div>
</div>

<style>
  .sv {
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .top {
    display: grid;
    gap: 0.6rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  .box .input {
    font-size: var(--fs-lg);
    padding: 0.6rem 0.9rem;
  }
  .facets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.2rem;
  }
  .grp {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .meta {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .warn {
    color: var(--you-ink);
  }
  .split {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  }
  .results {
    list-style: none;
    overflow-y: auto;
    padding: 0.5rem 0.75rem 2rem;
    display: grid;
    align-content: start;
    gap: 0.2rem;
  }
  .msg {
    padding: 1.5rem 0.75rem;
    color: var(--text-muted);
    display: grid;
    gap: 0.6rem;
    font-size: var(--fs-sm);
  }
  .msg.err {
    color: var(--alert-ink);
  }
  .hit {
    width: 100%;
    display: grid;
    gap: 0.25rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid transparent;
    border-radius: var(--r-control);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .hit:hover,
  .hit.sel {
    background: var(--ink-1);
    border-color: var(--line);
  }
  .hit.sel {
    border-color: var(--line-strong);
  }
  .hh {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .ht {
    flex: 1;
    font-weight: 620;
    color: var(--link);
  }
  .snip {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .hm {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.8rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .preview {
    overflow-y: auto;
    padding: 1rem 1.5rem 3rem;
    border-left: 1px solid var(--line);
    background: var(--ink-1);
    display: grid;
    align-content: start;
    gap: 0.75rem;
  }
  .ph {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    justify-content: space-between;
  }
  .ph h2 {
    font-size: var(--fs-xl);
  }
  .passages {
    display: grid;
    gap: 0.5rem;
  }
  .passages blockquote {
    font-size: var(--fs-sm);
    padding: 0.55rem 0.75rem;
    border-radius: var(--r-control);
    background: var(--ink-0);
    border-left: 3px solid var(--you-line);
    color: var(--text-muted);
  }
  .hd {
    display: block;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    margin-bottom: 0.2rem;
  }
  .tldr {
    padding-left: 0.75rem;
    border-left: 3px solid var(--busy);
  }
  .mini {
    font-size: var(--fs-md);
  }
  .small {
    font-size: var(--fs-xs);
  }
  @media (max-width: 1000px) {
    .split {
      grid-template-columns: minmax(0, 1fr);
    }
    .preview {
      display: none;
    }
  }
</style>
