<script lang="ts">
  import { loadGraph } from "../lib/lazy.ts";
  // Right panel of the active page: outline, backlinks and unlinked mentions, local graph,
  // properties. Each section folds; the state of the folds is remembered.
  import Icon from "../components/Icon.svelte";
  import { api, qs } from "../lib/api.ts";
  import { current, scrollToAnchor } from "../lib/current.svelte.ts";
  import { classificationName, nf, shortDate, typeLabel, valueLabel, VISIBILITIES } from "../lib/format.ts";
  import { pageEvents, prefetch } from "../lib/pages.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import type { Backlink, GraphEdge, GraphNode } from "../lib/types.ts";
  import { target } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { inspect } from "../lib/inspect.svelte.ts";
  import SourceInspector from "./SourceInspector.svelte";
  import { t } from "../lib/i18n.ts";

  const KEY = "cb-inspector";
  let folds = $state<Record<string, boolean>>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
      } catch {
        return {};
      }
    })(),
  );
  const toggle = (k: string) => {
    folds[k] = !folds[k];
    try {
      localStorage.setItem(KEY, JSON.stringify(folds));
    } catch {
      /* ignore */
    }
  };

  const shown = $derived(current.byTab[ws.tab.id]);
  // in the inbox the panel shows the selected document
  const inboxSource = $derived(ws.tab.view.kind === "inbox" ? (inspect.sourceByTab[ws.tab.id] ?? null) : null);
  const page = $derived(shown?.page);
  let links = $state<{ linked: Backlink[]; mentions: Backlink[] } | null>(null);
  let graph = $state<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  let depth = $state(1);

  $effect(() => {
    const id = page?.id;
    void pageEvents.saved;
    links = null;
    if (!id) return;
    const ctl = new AbortController();
    api.get<{ linked: Backlink[]; mentions: Backlink[] }>(`/api/pages/${encodeURIComponent(id)}/backlinks`, { signal: ctl.signal }).then(
      (r) => (links = r),
      () => {},
    );
    return () => ctl.abort();
  });

  $effect(() => {
    const id = page?.id;
    const d = depth;
    void pageEvents.saved;
    if (!id || folds.graph) return;
    const ctl = new AbortController();
    api.get<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/pages/${encodeURIComponent(id)}/neighbors${qs({ depth: d })}`, { signal: ctl.signal }).then(
      (r) => (graph = r),
      () => {},
    );
    return () => ctl.abort();
  });

  function jump(anchor: string) {
    const root = document.querySelector<HTMLElement>(`[data-tab="${ws.tab.id}"] .md.body`);
    scrollToAnchor(root, anchor);
  }

  /** Highlights the page title inside the context snippet of a backlink. */
  function ctxHtml(text: string, title: string): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    // plain text: no citations, heading marks, list bullets, emphasis or wikilink brackets
    const clean = text
      .replace(/\s?\^\[[^\]]*\]/g, "")
      .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, d?: string) => d ?? t)
      .replace(/^#+\s*/gm, "")
      .replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/gm, "")
      .replace(/\*\*|__/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const i = clean.toLowerCase().indexOf(title.toLowerCase());
    if (i < 0) return esc(clean);
    return `${esc(clean.slice(0, i))}<mark class="hl">${esc(clean.slice(i, i + title.length))}</mark>${esc(clean.slice(i + title.length))}`;
  }

  // readable names of frontmatter fields; any other field: "some_field" reads "Some field"
  const FM_LABEL: Record<string, string> = {
    hive_subject: t("Argomento dell'alveare"),
    sources_count: t("Fonti"),
  };
  const humanize = (k: string) => {
    const s = k.replace(/[_-]+/g, " ").trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const props = $derived.by(() => {
    if (!page) return [];
    const fm = page.frontmatter;
    const out: { k: string; v: string; mono?: boolean }[] = [
      { k: t("Tipo"), v: typeLabel(page.type) },
      { k: t("Classificazione"), v: valueLabel(classificationName(page.classification)) },
      { k: t("Visibilità"), v: VISIBILITIES[page.visibility] ?? "azienda" },
      { k: t("Vault"), v: session.vaultName(page.vaultId) },
      { k: t("Token"), v: nf.format(page.tokens) },
      { k: t("Aggiornata"), v: `${shortDate(page.updatedAt)} · v${page.version}` },
    ];
    if (page.aliases.length) out.push({ k: t("Alias"), v: page.aliases.join(", ") });
    if (page.tags.length) out.push({ k: t("Tag"), v: page.tags.map((t) => `#${t}`).join(" ") });
    if (page.confidence !== null) out.push({ k: t("Fiducia"), v: `${Math.round(page.confidence * 100)}%` });
    const sources = Array.isArray(fm.sources) ? fm.sources.length : 0;
    if (sources) out.push({ k: t("Sorgenti"), v: String(sources) });
    for (const [k, v] of Object.entries(fm)) {
      if (["id", "title", "type", "aliases", "tags", "tldr", "classification", "visibility", "sources", "confidence", "author"].includes(k)) continue;
      if (v === null || typeof v === "object") continue;
      out.push({ k: FM_LABEL[k] ?? humanize(k), v: String(v) });
    }
    out.push({ k: "Id", v: page.id, mono: true }, { k: t("Percorso"), v: page.path, mono: true });
    return out;
  });
</script>

<aside class="inspector" aria-label={inboxSource ? t("Documento selezionato") : t("Dettagli della pagina")}>
  {#if inboxSource}
    <SourceInspector id={inboxSource} />
  {:else if !page}
    <div class="none">
      <span class="none-icon" aria-hidden="true"><Icon name="file" size={20} /></span>
      <p>{t("Apri una pagina per vedere struttura, backlink, grafo locale e proprietà.")}</p>
    </div>
  {:else}
    <section>
      <button class="sh" aria-expanded={!folds.outline} onclick={() => toggle("outline")}><Icon name="outline" size={14} /><span>{t("Struttura")}</span></button>
      {#if !folds.outline}
        {#if shown?.headings.length}
          <ul class="outline">
            {#each shown?.headings ?? [] as h (h.id)}
              <li style:padding-left="{Math.max(0, h.level - 2) * 0.8}rem"><button onclick={() => jump(h.id)}>{h.title}</button></li>
            {/each}
          </ul>
        {:else}
          <p class="dim small">{t("Nessun titolo di sezione.")}</p>
        {/if}
      {/if}
    </section>

    <section>
      <button class="sh" aria-expanded={!folds.backlinks} onclick={() => toggle("backlinks")}>
        <Icon name="backlink" size={14} /><span>{t("Backlink")}</span><span class="n tabular">{links ? links.linked.length : page.backlinks}</span>
      </button>
      {#if !folds.backlinks}
        {#if !links}
          <span class="skeleton" style="height:2.4rem"></span>
        {:else}
          {#if !links.linked.length}<p class="dim small">{t("Nessuna pagina collega questa pagina.")}</p>{/if}
          <ul class="bl">
            {#each links.linked as b (b.id)}
              <li>
                <a href="#/p/{b.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: b.id }, target(e)))} onmouseenter={() => prefetch(b.id)}>{b.title}</a>
                <p class="ctx">{@html ctxHtml(b.context, page.title)}</p>
              </li>
            {/each}
          </ul>
          {#if links.mentions.length}
            <p class="sub">{t("Menzioni non collegate")} <span class="n">{links.mentions.length}</span></p>
            <ul class="bl">
              {#each links.mentions as b (b.id)}
                <li>
                  <a href="#/p/{b.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: b.id }, target(e)))} onmouseenter={() => prefetch(b.id)}>{b.title}</a>
                  <p class="ctx">{@html ctxHtml(b.context, page.title)}</p>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {/if}
    </section>

    <section>
      <div class="sh-row">
        <button class="sh" aria-expanded={!folds.graph} onclick={() => toggle("graph")}><Icon name="graph" size={14} /><span>{t("Grafo locale")}</span></button>
        {#if !folds.graph}
          <div class="depth" role="radiogroup" aria-label={t("Profondità")}>
            {#each [1, 2] as d (d)}
              <button role="radio" aria-checked={depth === d} class="chip" onclick={() => (depth = d)}>{d}</button>
            {/each}
          </div>
        {/if}
      </div>
      {#if !folds.graph}
        <div class="lg" class:bare={graph && graph.nodes.length <= 1}>
          {#if graph && graph.nodes.length > 1}
            {#await loadGraph() then { default: GraphCanvas }}
              <GraphCanvas nodes={graph.nodes} edges={graph.edges} focusId={page.id} compact label={t("Grafo locale")} onopen={(id, e) => ws.open({ kind: "page", id }, target(e as MouseEvent))} />
            {/await}
          {:else if graph}
            <p class="dim small pad">{t("Nessun collegamento.")}</p>
          {:else}
            <span class="skeleton" style="height:100%"></span>
          {/if}
        </div>
      {/if}
    </section>

    <section>
      <button class="sh" aria-expanded={!folds.props} onclick={() => toggle("props")}><Icon name="props" size={14} /><span>{t("Proprietà")}</span></button>
      {#if !folds.props}
        <dl class="props">
          {#each props as p (p.k)}
            <dt>{p.k}</dt>
            <dd class:mono={p.mono}>{p.v}</dd>
          {/each}
        </dl>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .inspector {
    min-height: 0;
    overflow-y: auto;
    background: var(--sidebar-bg);
    border-left: 1px solid var(--line);
    padding: 0.5rem 0.75rem 2rem;
    display: grid;
    align-content: start;
    gap: 0.25rem;
  }
  .none {
    display: grid;
    justify-items: center;
    gap: 0.75rem;
    margin-top: 30vh;
    padding: 0 1rem;
    text-align: center;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    line-height: 1.55;
  }
  .none-icon {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    background: var(--ink-3);
    color: var(--text-muted);
  }
  section {
    display: grid;
    gap: 0.4rem;
    padding: 0.35rem 0 0.6rem;
    border-bottom: 1px solid var(--line);
  }
  section:last-child {
    border-bottom: 0;
  }
  .sh-row {
    display: flex;
    align-items: center;
  }
  .sh {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.3rem 0.25rem;
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-main);
    font-size: var(--fs-sm);
    font-weight: 620;
    text-align: left;
  }
  .sh span:first-of-type {
    flex: 1;
  }
  .sh[aria-expanded="false"] {
    color: var(--text-dim);
  }
  .n {
    color: var(--text-dim);
    font-weight: 500;
  }
  .outline {
    list-style: none;
    display: grid;
  }
  .outline button {
    width: 100%;
    border: 0;
    background: none;
    text-align: left;
    padding: 0.2rem 0.35rem;
    border-radius: 5px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .outline button:hover {
    background: var(--ink-2);
    color: var(--text-main);
  }
  .bl {
    list-style: none;
    display: grid;
    gap: 0.55rem;
  }
  .bl a {
    font-size: var(--fs-sm);
    font-weight: 560;
    color: var(--link);
    text-decoration: none;
  }
  .bl a:hover {
    text-decoration: underline;
  }
  .ctx {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .sub {
    font-size: var(--fs-xs);
    color: var(--text-muted);
    margin-top: 0.4rem;
  }
  .depth {
    display: flex;
    gap: 0.25rem;
  }
  .depth .chip {
    padding: 0 0.5rem;
  }
  .lg.bare {
    height: auto;
    background: none;
    border-style: dashed;
  }
  .lg {
    height: 14rem;
    border-radius: var(--r-control);
    background: var(--ink-0);
    border: 1px solid var(--line);
    overflow: hidden;
    display: grid;
  }
  .pad {
    padding: 1rem;
  }
  .lg.bare .pad {
    padding: 0.6rem 0.75rem;
  }
  .props {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.75rem;
    font-size: var(--fs-xs);
  }
  .props dt {
    color: var(--text-dim);
  }
  .props dd {
    color: var(--text-main);
    overflow-wrap: anywhere;
  }
  .small {
    font-size: var(--fs-xs);
  }
</style>
