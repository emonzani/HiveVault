<script lang="ts">
  import { loadGraph } from "../../lib/lazy.ts";
  // Knowledge graph: the pages of the chosen
  // vaults, gathered by vault inside dashed areas, with filters by vault and by type, the
  // selected page in a card, a minimap and a legend. Progressive loading: the most linked pages
  // come first, "Carica altre pagine" adds the next ring.
  import { untrack } from "svelte";
  import Button from "../../components/Button.svelte";
  import Icon from "../../components/Icon.svelte";
  import VaultFilter from "../../components/VaultFilter.svelte";
  import { api, qs } from "../../lib/api.ts";
  import { FOLDERS, folderOf, nf, typeLabel } from "../../lib/format.ts";
  import { session } from "../../lib/session.svelte.ts";
  import type { GraphEdge, GraphNode } from "../../lib/types.ts";
  import { target } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";

  const STEP = 300;
  const LEGEND = 5;
  // no vault chosen = every readable vault
  let vaults = $state<string[]>([]);
  let types = $state<string[]>([]);
  let nodes = $state<GraphNode[]>([]);
  let edges = $state<GraphEdge[]>([]);
  let more = $state(false);
  let loading = $state(false);
  let error = $state("");
  let selected = $state<string | null>(null);
  let grouped = $state(true);
  let frozen = $state(false);
  let allLabels = $state(false);
  let canvasRef = $state<{ fit: (vaultId?: string) => void } | undefined>();

  async function load(reset: boolean) {
    loading = true;
    error = "";
    try {
      const offset = reset ? 0 : nodes.length;
      const r = await api.get<{ nodes: GraphNode[]; edges: GraphEdge[]; more: boolean }>(`/api/graph${qs({ vaults: vaults.join(","), limit: STEP, offset })}`);
      const known = new Set(reset ? [] : nodes.map((n) => n.id));
      nodes = reset ? r.nodes : [...nodes, ...r.nodes.filter((n) => !known.has(n.id))];
      const ek = new Set(reset ? [] : edges.map((e) => `${e.from}>${e.to}`));
      edges = reset ? r.edges : [...edges, ...r.edges.filter((e) => !ek.has(`${e.from}>${e.to}`))];
      more = r.more;
      if (selected && !nodes.some((n) => n.id === selected)) selected = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void vaults.join();
    untrack(() => void load(true));
  });

  // the color of a vault: its place among the readable vaults, in the series palette
  const vaultIndex = $derived(new Map(session.vaults.map((v, i) => [v.id, i])));
  const colorOf = (id: string) => vaultIndex.get(id) ?? 0;
  const swatch = (id: string) => `var(--series-${(colorOf(id) % 6) + 1})`;

  // filter by type on the client: the counters stay those of the loaded pages
  const counts = $derived(nodes.reduce<Record<string, number>>((m, n) => ((m[folderOf(n.type)] = (m[folderOf(n.type)] ?? 0) + 1), m), {}));
  const shownNodes = $derived(types.length ? nodes.filter((n) => types.includes(folderOf(n.type))) : nodes);
  const shownEdges = $derived.by(() => {
    const ids = new Set(shownNodes.map((n) => n.id));
    return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  });
  const inGraph = $derived([...new Set(shownNodes.map((n) => n.vaultId))]);
  const crossLinks = $derived(shownEdges.filter((e) => e.cross).length);

  const sel = $derived(selected ? (nodes.find((n) => n.id === selected) ?? null) : null);
  const selLinks = $derived.by(() => {
    if (!sel) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // one row per neighbor: a page linked both ways shows ↔
    const out = new Map<string, { node: GraphNode; dir: "out" | "in" | "both"; cross: boolean }>();
    for (const e of edges) {
      const other = e.from === sel.id ? e.to : e.to === sel.id ? e.from : null;
      if (!other || !byId.has(other)) continue;
      const dir = e.from === sel.id ? "out" : "in";
      const prev = out.get(other);
      out.set(other, { node: byId.get(other)!, dir: prev && prev.dir !== dir ? "both" : dir, cross: !!e.cross || !!prev?.cross });
    }
    return [...out.values()];
  });

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const open = (id: string, e: MouseEvent | KeyboardEvent) => ws.open({ kind: "page", id }, e.ctrlKey || e.metaKey ? "tab" : target(e as MouseEvent));
</script>

<div class="gv">
  <header class="filters">
    <VaultFilter bind:selected={vaults} vaults={session.vaults} {swatch} eyebrow />
    <div class="grp" role="group" aria-label={t("Tipi di pagina")}>
      <span class="eyebrow lbl">{t("Tipi")}</span>
      <button class="chip" aria-pressed={!types.length} onclick={() => (types = [])}>{t("Tutti")} <span class="n">{nodes.length}</span></button>
      {#each FOLDERS.filter((f) => counts[f.id]) as f (f.id)}
        <button class="chip" aria-pressed={types.includes(f.id)} onclick={() => (types = toggle(types, f.id))}><span class="ti {f.id}" aria-hidden="true">{f.icon}</span>{f.label} <span class="n">{counts[f.id]}</span></button>
      {/each}
    </div>
    <div class="grp opts">
      <label class="switch"><input type="checkbox" bind:checked={grouped} /><span class="track" aria-hidden="true"></span>{t("Raggruppa per vault")}</label>
      <label class="switch"><input type="checkbox" bind:checked={allLabels} /><span class="track" aria-hidden="true"></span>{t("Tutti i titoli")}</label>
    </div>
  </header>

  <div class="canvas">
    {#if error}
      <div class="empty"><p>{error}</p></div>
    {:else if !shownNodes.length && !loading}
      <div class="empty"><h2>{t("Nessuna pagina")}</h2><p>{t("Scegli almeno un vault con pagine collegate.")}</p></div>
    {:else}
      {#await loadGraph() then { default: GraphCanvas }}
        <GraphCanvas
          bind:this={canvasRef}
          nodes={shownNodes}
          edges={shownEdges}
          selectedId={selected}
          onselect={(id) => (selected = id)}
          onopen={open}
          clusters={grouped}
          vaultColor={colorOf}
          vaultName={(id) => session.vaultName(id)}
          {frozen}
          {allLabels}
          minimap
        />
      {/await}
    {/if}

    <div class="tools" role="toolbar" aria-label={t("Controlli del grafo")}>
      <span class="phys"><span class="dot {frozen ? 'dim' : 'busy'}" aria-hidden="true"></span>{t("Disposizione {x}", { x: frozen ? t("ferma") : t("attiva") })}</span>
      <button class="tool" aria-pressed={frozen} onclick={() => (frozen = !frozen)}><Icon name={frozen ? "play" : "stop"} size={14} />{frozen ? t("Riprendi") : t("Congela nodi")}</button>
      <button class="tool" onclick={() => canvasRef?.fit(sel?.vaultId)}><Icon name="graph" size={14} />{sel ? t("Centra il cluster") : t("Centra")}</button>
    </div>

    <div class="status">
      <span class="tabular">{t("{length} pagine · {length2} collegamenti", { length: nf.format(shownNodes.length), length2: nf.format(shownEdges.length) })}{#if crossLinks} {t("· {crossLinks} tra vault", { crossLinks })}{/if}</span>
      {#if more}<Button size="sm" busy={loading} onclick={() => load(false)}>{t("Carica altre pagine")}</Button>{/if}
      {#if loading && !nodes.length}<span class="dim">{t("Caricamento…")}</span>{/if}
    </div>

    {#if grouped && inGraph.length > 1}
      <ul class="legend" aria-label={t("Legenda dei vault")}>
        {#each inGraph.slice(0, LEGEND) as id (id)}<li><span class="sw" style="background:{swatch(id)}" aria-hidden="true"></span>{session.vaultName(id)}</li>{/each}
        {#if inGraph.length > LEGEND}<li class="dim">{t("e altri {x} vault", { x: inGraph.length - LEGEND })}</li>{/if}
        {#if crossLinks}<li><span class="dash" aria-hidden="true"></span>{t("collegamento tra vault")}</li>{/if}
      </ul>
    {/if}

    {#if sel}
      <aside class="card" aria-label={t("Pagina selezionata")}>
        <p class="eyebrow you">{t("Pagina selezionata")}</p>
        <h2>{sel.title}</h2>
        <p class="meta"><span class="ti {folderOf(sel.type)}" aria-hidden="true">{FOLDERS.find((f) => f.id === folderOf(sel.type))?.icon ?? "▫"}</span>{typeLabel(sel.type)}</p>
        <dl class="facts">
          <div><dt>{t("Vault")}</dt><dd><span class="sw" style="background:{swatch(sel.vaultId)}" aria-hidden="true"></span>{session.vaultName(sel.vaultId)}</dd></div>
          <div><dt>{t("Collegamenti")}</dt><dd class="mono">{selLinks.length}</dd></div>
        </dl>
        {#if selLinks.length}
          <ul class="links">
            {#each selLinks.slice(0, 6) as l (l.node.id)}
              <li>
                <span class="dir mono" title={l.dir === "out" ? t("questa pagina la cita") : l.dir === "in" ? t("cita questa pagina") : t("si citano a vicenda")}>{l.dir === "out" ? "→" : l.dir === "in" ? "←" : "↔"}</span>
                <button class="lk" onclick={() => (selected = l.node.id)}>{l.node.title}</button>
                {#if l.cross}<span class="badge">{t("tra vault")}</span>{/if}
              </li>
            {/each}
            {#if selLinks.length > 6}<li class="dim">{t("e altri {x}", { x: selLinks.length - 6 })}</li>{/if}
          </ul>
        {/if}
        <div class="acts">
          <Button size="sm" variant="primary" onclick={(e: MouseEvent) => open(sel.id, e)}>{t("Apri la pagina")}</Button>
          <Button size="sm" onclick={() => ws.open({ kind: "page", id: sel.id }, "split")}>{t("Apri a lato")}</Button>
          <Button size="sm" variant="quiet" onclick={() => (selected = null)}>{t("Chiudi")}</Button>
        </div>
      </aside>
    {/if}
  </div>
</div>

<style>
  .gv {
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1.5rem;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--line);
    background: var(--ink-1);
  }
  .grp {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
  }
  .lbl {
    margin-right: 0.35rem;
  }
  .opts {
    gap: 1rem;
  }
  .sw {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
  }
  .ti {
    font-size: 0.8em;
  }
  .ti.entity {
    color: var(--tax-entity);
  }
  .ti.concept {
    color: var(--tax-concept);
  }
  .ti.decision {
    color: var(--tax-decision);
  }
  .ti.synthesis {
    color: var(--tax-synthesis);
  }
  .ti.source {
    color: var(--tax-source);
  }
  .ti.note {
    color: var(--tax-note);
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    cursor: pointer;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
  .track {
    position: relative;
    width: 2rem;
    height: 1.1rem;
    border-radius: 9999px;
    background: var(--ink-3);
    border: 1px solid var(--line-strong);
    transition: background-color var(--transition-fast);
  }
  .track::after {
    content: "";
    position: absolute;
    top: 0.12rem;
    left: 0.15rem;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: var(--text-muted);
    transition: transform var(--transition-fast);
  }
  .switch input:checked + .track {
    background: var(--you);
    border-color: var(--you);
  }
  .switch input:checked + .track::after {
    transform: translateX(0.85rem);
    background: var(--on-you);
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--you);
    outline-offset: 2px;
  }
  .canvas {
    position: relative;
    min-height: 0;
    display: grid;
    background: var(--ink-0);
  }
  .tools {
    position: absolute;
    left: 0.75rem;
    top: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
    box-shadow: var(--shadow-subtle);
  }
  .phys {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.5rem;
    font-variant-numeric: tabular-nums;
    font-size: 0.6875rem;
    color: var(--text-muted);
    border-right: 1px solid var(--line);
  }
  .tool {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.55rem;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-main);
    font-size: var(--fs-xs);
    font-weight: 600;
    cursor: pointer;
  }
  .tool:hover {
    background: var(--ink-2);
  }
  .tool[aria-pressed="true"] {
    background: var(--you-soft);
    color: var(--you-ink);
  }
  .status {
    position: absolute;
    right: 0.75rem;
    top: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.3rem 0.4rem 0.3rem 0.75rem;
    border-radius: var(--r-control);
    background: color-mix(in srgb, var(--ink-1) 88%, transparent);
    border: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }
  .legend {
    position: absolute;
    left: 13.5rem;
    bottom: 0.75rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.1rem;
    max-width: calc(100% - 14.5rem);
    padding: 0.45rem 0.85rem;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
    box-shadow: var(--shadow-subtle);
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
    color: var(--text-main);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .dash {
    width: 1.2rem;
    border-top: 2px dashed var(--text-dim);
  }
  .card {
    position: absolute;
    right: 0.75rem;
    top: 3.4rem;
    width: min(20rem, calc(100% - 1.5rem));
    max-height: calc(100% - 4.5rem);
    overflow: auto;
    display: grid;
    gap: 0.55rem;
    padding: 0.85rem 0.95rem;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
    box-shadow: var(--shadow-subtle);
  }
  .card h2 {
    font-size: var(--fs-lg);
    font-weight: 700;
    letter-spacing: -0.015em;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.4rem 1rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--r-control);
    background: var(--ink-2);
  }
  .facts dt {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .facts dd {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .links {
    list-style: none;
    display: grid;
    gap: 0.2rem;
    font-size: var(--fs-sm);
  }
  .links li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }
  .dir {
    color: var(--text-dim);
  }
  .lk {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent-blue);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lk:hover {
    text-decoration: underline;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  @media (max-width: 900px) {
    .legend {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .phys {
      display: none;
    }
    .status {
      top: auto;
      bottom: 0.75rem;
    }
  }
</style>
