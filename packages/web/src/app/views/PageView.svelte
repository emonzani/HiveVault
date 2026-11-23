<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import Button from "../../components/Button.svelte";
  import ClassTag from "../../components/ClassTag.svelte";
  import Icon from "../../components/Icon.svelte";
  import { api, ApiError } from "../../lib/api.ts";
  import { current, scrollToAnchor } from "../../lib/current.svelte.ts";
  import { classificationName, folderLabel, folderOf, nf, typeLabel, valueLabel, VISIBILITIES, when } from "../../lib/format.ts";
  import { renderPage, type RenderedPage } from "../../lib/markdown.ts";
  import { pageCache, pageEvents, prefetch } from "../../lib/pages.svelte.ts";
  import { session } from "../../lib/session.svelte.ts";
  import type { FullPage } from "../../lib/types.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { loadEditor } from "../../lib/lazy.ts";
  import { t } from "../../lib/i18n.ts";

  let { tabId, id, anchor, edit, paneIndex }: { tabId: string; id: string; anchor?: string | undefined; edit: boolean; paneIndex: number } = $props();

  let page = $state<FullPage | null>(null);
  let rendered = $state<RenderedPage | null>(null);
  let error = $state<{ status: number; message: string } | null>(null);
  let scroller: HTMLDivElement | undefined = $state();
  let bodyEl: HTMLDivElement | undefined = $state();
  let menu = $state(false);
  let loadedId = "";

  function show(p: FullPage) {
    page = p;
    rendered = renderPage(p.body, p.links, p.citations);
    error = null;
    ws.setTitle(tabId, p.title);
    current.set(tabId, { page: p, headings: rendered.headings });
  }

  async function load(pageId: string, force = false) {
    const t0 = performance.now();
    const cached = pageCache.peek(pageId);
    if (cached && !force) show(cached);
    else if (loadedId !== pageId) {
      page = null;
      rendered = null;
    }
    try {
      const p = await pageCache.get(pageId, force);
      if (pageId !== id) return;
      if (!cached || p !== cached || force) show(p);
    } catch (e) {
      if (pageId !== id) return;
      if (!cached) {
        error = e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0, message: t("Pagina non disponibile.") };
        ws.setTitle(tabId, t("Pagina non trovata"));
      }
    }
    loadedId = pageId;
    await tick();
    performance.measure?.("cb-page-open", { start: t0 });
    if (scroller) scroller.dataset.ready = pageId;
  }

  $effect(() => {
    const pid = id;
    untrack(() => void load(pid));
  });

  // another view saved this page (or the editor here did): reload
  $effect(() => {
    if (pageEvents.saved && pageEvents.lastId === id) untrack(() => void load(id, true));
  });

  $effect(() => {
    if (anchor && rendered && !edit) void tick().then(() => scrollToAnchor(bodyEl ?? null, anchor));
  });

  onDestroy(() => current.clear(tabId));

  function setEdit(on: boolean) {
    ws.replace({ kind: "page", id, ...(anchor ? { anchor } : {}), ...(on ? { edit: true } : {}) });
  }

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e" && page?.canWrite) {
      e.preventDefault();
      setEdit(!edit);
    }
  }

  /** Clicks inside the rendered body: wikilinks, missing pages, citations, same-page anchors. */
  function onBodyClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("a.wl, button.cite");
    if (!el) return;
    e.preventDefault();
    if (el.matches("button.cite")) {
      const c = page?.citations.find((x) => x.ref === el.dataset.cite);
      if (c?.kind === "source") ws.open({ kind: "source", id: c.id, ...(c.chunkId ? { chunk: c.chunkId } : {}) }, target(e));
      else if (c?.kind === "page") ws.open({ kind: "page", id: c.id }, target(e));
      return;
    }
    if (el.dataset.page) {
      ws.open({ kind: "page", id: el.dataset.page, ...(el.dataset.anchor ? { anchor: el.dataset.anchor } : {}) }, target(e));
    } else if (el.dataset.anchor) {
      scrollToAnchor(bodyEl ?? null, el.dataset.anchor);
    } else if (el.dataset.create !== undefined) {
      if (page?.canWrite) ui.newPage = { title: el.dataset.create, vaultId: page.vaultId };
      else ui.toast(t("Questa pagina non esiste ancora e non hai i permessi per crearla in questo vault."));
    }
  }
  function onAux(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("a.wl[data-page]");
    if (el && e.button === 1) {
      e.preventDefault();
      ws.open({ kind: "page", id: el.dataset.page! }, "tab");
    }
  }
  function onOver(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("a.wl[data-page]");
    if (el) prefetch(el.dataset.page!);
  }

  async function remove() {
    menu = false;
    if (!page || !confirm(t("Eliminare la pagina \"{title}\"? I link che puntano qui resteranno in attesa di una nuova pagina.", { title: page.title }))) return;
    try {
      await api.del(`/api/pages/${encodeURIComponent(page.id)}`);
      pageEvents.notify(page.id);
      ui.toast(t("Pagina \"{title}\" eliminata.", { title: page.title }), "ok");
      ws.replace({ kind: "home" });
    } catch (e) {
      ui.toast((e as Error).message, "error");
    }
  }

  function copyLink() {
    menu = false;
    void navigator.clipboard?.writeText(`${location.origin}/#/p/${id}`);
    ui.toast(t("Link copiato."), "ok");
  }

  function copyWikilink() {
    menu = false;
    if (page) void navigator.clipboard?.writeText(`[[${page.title}]]`);
    ui.toast(t("Wikilink copiato."), "ok");
  }

  let verifying = $state(false);
  /** "È corretta": the page counts as checked from today (its review period starts again). */
  async function verify() {
    if (!page) return;
    verifying = true;
    try {
      await api.post(`/api/pages/${encodeURIComponent(page.id)}/verify`, { baseVersion: page.version });
      pageEvents.notify(page.id);
      ui.toast(t("Pagina confermata: conta come controllata da oggi."), "ok");
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      verifying = false;
    }
  }
  const LEVEL: Record<string, string> = { alta: t("Affidabilità alta"), media: t("Affidabilità media"), bassa: t("Affidabilità bassa") };
  const relTitle = (r: NonNullable<FullPage["reliability"]>) =>
    [
      t("{n} fonti citate", { n: r.sources }),
      r.conflicts ? t("{n} conflitti aperti", { n: r.conflicts }) : "",
      r.verified ? t("confermata da {by} il {at}", { by: r.verified.by, at: r.verified.at }) : "",
      r.reviewAfter ? (r.reviewDue ? t("da ricontrollare dal {at}", { at: r.reviewAfter }) : t("ricontrollo previsto il {at}", { at: r.reviewAfter })) : "",
    ]
      .filter(Boolean)
      .join(" · ");

  const cites = $derived(page && rendered ? [...rendered.citeOrder.entries()].map(([ref, n]) => ({ n, ref, c: page!.citations.find((x) => x.ref === ref) })) : []);
  const vaultName = $derived(page ? session.vaultName(page.vaultId) : "");
</script>

<svelte:window onkeydown={onKey} onclick={(e) => menu && !(e.target as HTMLElement).closest(".menu-wrap") && (menu = false)} />

<div class="view" data-tab={tabId}>
  {#if error}
    <div class="empty">
      <h2>{error.status === 404 ? t("Pagina non trovata") : t("Pagina non disponibile")}</h2>
      <p>{error.status === 404 ? t("La pagina non esiste, è stata eliminata oppure non hai accesso al suo vault.") : error.message}</p>
      <Button onclick={() => ws.replace({ kind: "home" })}>{t("Torna all'inizio")}</Button>
    </div>
  {:else if !page || !rendered}
    <div class="scroll"><div class="col sk">
      <span class="skeleton" style="height:0.9rem;width:30%"></span>
      <span class="skeleton" style="height:2rem;width:65%"></span>
      <span class="skeleton" style="height:3.5rem;width:100%"></span>
      <span class="skeleton" style="height:1rem;width:90%"></span>
      <span class="skeleton" style="height:1rem;width:80%"></span>
    </div></div>
  {:else if edit && page.canWrite}
    {#await loadEditor()}
      <div class="scroll"><span class="skeleton" style="height:60vh"></span></div>
    {:then { default: Editor }}
      <Editor {page} onclose={() => setEdit(false)} />
    {/await}
  {:else}
    <div class="scroll" bind:this={scroller}>
      <article class="col" aria-labelledby="h-{tabId}">
        <header class="head">
          <div class="crumbs">
            <span>{vaultName}</span><span aria-hidden="true">›</span>
            <span>{folderLabel(folderOf(page.type))}</span>
            {#if page.type.includes("/")}<span aria-hidden="true">›</span><span>{page.type.split("/").slice(1).join("/")}</span>{/if}
          </div>
          <div class="title-row">
            <h1 id="h-{tabId}">{page.title}</h1>
            <div class="actions">
              <button class="icon-btn" aria-pressed={ui.isFavorite(page.id)} title={ui.isFavorite(page.id) ? t("Togli dai preferiti") : t("Aggiungi ai preferiti")} aria-label={t("Preferito")} onclick={() => ui.toggleFavorite({ id: page!.id, title: page!.title })}>
                <Icon name="star" />
              </button>
              <button class="icon-btn" title={t("Storico delle versioni")} aria-label={t("Storico delle versioni")} onclick={(e) => ws.open({ kind: "history", id: page!.id }, target(e))}><Icon name="history" /></button>
              {#if page.canWrite}
                <Button size="sm" onclick={() => setEdit(true)}><Icon name="edit" size={14} />{t("Modifica")} <kbd>Ctrl E</kbd></Button>
              {/if}
              <div class="menu-wrap">
                <button class="icon-btn" aria-label={t("Altre azioni")} aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}><Icon name="more" /></button>
                {#if menu}
                  <div class="menu" role="menu">
                    <button role="menuitem" onclick={() => ((menu = false), ws.open({ kind: "page", id: page!.id }, "split"))}>{t("Apri nell'altro pannello")}</button>
                    <button role="menuitem" onclick={copyLink}>{t("Copia il link")}</button>
                    <button role="menuitem" onclick={copyWikilink}>{t("Copia come [[wikilink]]")}</button>
                    <a role="menuitem" href="/api/pages/{encodeURIComponent(page.id)}/markdown" download="{page.path.split('/').pop()}" onclick={() => (menu = false)}>{t("Scarica il file Markdown")}</a>
                    {#if page.canWrite}<button role="menuitem" class="danger" onclick={remove}>{t("Elimina la pagina")}</button>{/if}
                  </div>
                {/if}
              </div>
            </div>
          </div>
          <div class="facts">
            <ClassTag level={classificationName(page.classification)} />
            {#if page.agentReadable}
              <span class="agent" title={t("Almeno un account API autorizzato può leggere il testo compilato di questa pagina. I documenti originali non escono mai dal server.")}><Icon name="agent" size={13} />{t("Consultabile dall'agente cloud")}</span>
            {:else}
              <span class="dim" title={t("Nessun account API può leggere questa pagina")}>{t("Solo in azienda")}</span>
            {/if}
            {#if page.frontmatter.hive_subject}
              <span class="hive" title={t("Pagina costruita dal ciclo notturno con le informazioni delle celle; ogni frase cita la pagina di origine")}>
                <Icon name="hive" size={13} />{t("Alveare · {x} celle, {x2} pagine", { x: (page.frontmatter.promoted_from as string[] | undefined)?.length ?? 0, x2: String(page.frontmatter.sources_count ?? 0) })}
              </span>
            {/if}
            <span class="dim">{valueLabel(VISIBILITIES[page.visibility] ?? "azienda")}</span>
            <span class="dim">{typeLabel(page.type)}</span>
            <span class="dim tabular" title={t("Costo di lettura per l'agente cloud")}>{t("{tokens} token", { tokens: nf.format(page.tokens) })}</span>
            <span class="dim" title={t("Versione {version}", { version: page.version })}>{t("aggiornata {updatedAt} · v{version}", { updatedAt: when(page.updatedAt), version: page.version })}</span>
            {#if page.confidence !== null}<span class="dim" title={t("Fiducia della compilazione")}>{t("fiducia {round}%", { round: Math.round(page.confidence * 100) })}</span>{/if}
            {#if page.reliability}
              <span class="rel" class:low={page.reliability.level === "bassa"} title={relTitle(page.reliability)}>
                {LEVEL[page.reliability.level]}{#if page.reliability.reviewDue} · {t("da ricontrollare")}{:else if page.reliability.verified} · {t("confermata")}{/if}
              </span>
              {#if page.canWrite && !page.generated}
                <button class="link-btn" disabled={verifying} onclick={verify} title={t("Conferma che la pagina è corretta: conta come controllata da oggi")}>{t("È corretta")}</button>
              {/if}
            {/if}
          </div>
          {#if page.generated}
            <p class="notice small">
              {t("Pagina scritta dal ciclo notturno: si aggiorna da sola. {x}", { x: page.frontmatter.hive_subject ? t("Per cambiarla modifica le pagine delle celle o decidi i conflitti nella coda dei curatori.") : "" })}
              {#if page.rectifiable}{t("Come amministratore puoi rettificarla subito con «Modifica».")}{/if}
            </p>
          {/if}
          {#if page.tldr && !page.body.includes(page.tldr.slice(0, 60))}
            <p class="tldr prov-compiled">{page.tldr}</p>
          {/if}
        </header>

        <!-- Links and citation chips inside are real <a>/<button> elements: the handlers only delegate. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_mouse_events_have_key_events -->
        <div class="md body" bind:this={bodyEl} onclick={onBodyClick} onauxclick={onAux} onmouseover={onOver}>
          {@html rendered.html}
        </div>

        {#if cites.length}
          <footer class="sources" aria-label={t("Fonti")}>
            <h2>{t("Fonti")}</h2>
            <ol>
              {#each cites as s (s.ref)}
                <li>
                  <span class="n mono">{s.n}</span>
                  {#if s.c && s.c.kind === "source"}
                    <a href="#/sorgente/{s.c.id}{s.c.chunkId ? `/${s.c.chunkId}` : ''}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "source", id: s.c!.id, ...(s.c!.chunkId ? { chunk: s.c!.chunkId } : {}) }, target(e)))}>{s.c.name ?? s.c.id}</a>
                    {#if s.c.excerpt}<span class="ex">«{s.c.excerpt.slice(0, 140)}{s.c.excerpt.length > 140 ? "…" : ""}»</span>{/if}
                  {:else if s.c && s.c.kind === "page"}
                    <a href="#/p/{s.c.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: s.c!.id }, target(e)))}>{s.c.name}</a>
                  {:else if /^(ent|cpt|dec|syn|pag|spg)_/.test(s.ref)}
                    <span class="private">{t("Pagina di una cella a cui non hai accesso")}</span>
                  {:else}
                    <span class="missing">{t("Fonte non disponibile")} <span class="mono">{s.ref}</span></span>
                  {/if}
                </li>
              {/each}
            </ol>
          </footer>
        {/if}
      </article>
    </div>
  {/if}
</div>

<style>
  .view {
    min-height: 0;
    display: grid;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
    padding: 2rem 2.5rem 6rem;
  }
  .col {
    max-width: var(--measure);
    margin: 0 auto;
    display: grid;
    gap: 1.4rem;
  }
  .sk {
    gap: 0.9rem;
  }
  .head {
    display: grid;
    gap: 0.6rem;
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem 1rem;
  }
  /* the title keeps a readable width: on a narrow pane the actions go to the next line */
  h1 {
    flex: 1 1 16rem;
    min-width: min(16rem, 100%);
    font-size: var(--fs-2xl);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding-top: 0.2rem;
  }
  .actions :global(.btn) {
    margin: 0 0.3rem;
  }
  .actions kbd {
    margin-left: 0.2rem;
  }
  .menu-wrap {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 0.3rem);
    z-index: 20;
    min-width: 15rem;
    display: grid;
    padding: 0.3rem;
    border-radius: var(--r-panel);
    border: 1px solid var(--line-strong);
    background: var(--ink-1);
    box-shadow: var(--shadow-subtle);
  }
  .menu > * {
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: 6px;
    background: none;
    text-align: left;
    font-size: var(--fs-sm);
    color: var(--text-main);
    text-decoration: none;
    cursor: pointer;
  }
  .menu > *:hover {
    background: var(--ink-2);
  }
  .menu .danger {
    color: var(--alert-ink);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 1rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    /* clips the dot of an item that wraps to the start of a line */
    overflow: hidden;
  }
  /* the quiet facts read as one line: a dot in the gap before each of them */
  .facts > .dim {
    position: relative;
  }
  .facts > .dim + .dim::before {
    content: "·";
    position: absolute;
    left: -0.65rem;
    color: var(--text-dim);
  }
  .facts > :global(:first-child) {
    margin-right: 0.25rem;
  }
  .rel {
    font-weight: 600;
    color: var(--text-main);
  }
  .rel.low {
    color: var(--alert-ink);
  }
  .link-btn {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--accent-blue);
    text-decoration: underline;
    cursor: pointer;
  }
  .link-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .agent {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--accent-blue);
    font-weight: 600;
  }
  .tldr {
    margin-top: 1rem;
    font-size: var(--fs-xl);
    line-height: 1.45;
    padding-left: 1rem;
    border-left: 3px solid var(--busy);
    color: var(--text-main);
  }
  .sources {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 0.6rem;
  }
  .sources h2 {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    font-weight: 600;
  }
  .sources ol {
    list-style: none;
    display: grid;
    gap: 0.5rem;
    font-size: var(--fs-sm);
  }
  .sources li {
    display: grid;
    grid-template-columns: 1.6rem 1fr;
    column-gap: 0.4rem;
  }
  .sources .n {
    grid-row: span 2;
    font-size: 0.72rem;
    color: var(--idle-ink);
    padding-top: 0.15rem;
  }
  .sources .ex {
    color: var(--text-dim);
    font-size: var(--fs-xs);
  }
  .missing {
    color: var(--alert-ink);
  }
  .private {
    color: var(--text-muted);
  }
  .notice.small {
    font-size: var(--fs-xs);
  }
  .hive {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--you-ink);
    font-weight: 600;
  }
  @media (max-width: 900px) {
    .scroll {
      padding: 1.25rem 1rem 4rem;
    }
  }
</style>
