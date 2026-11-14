<script lang="ts">
  // Source view (plan §9.2): the original rendered by the browser (PDF, images, text) beside
  // the extracted text, with the cited chunk highlighted. Other formats are a download.
  import { tick, untrack } from "svelte";
  import Button from "../../components/Button.svelte";
  import ClassTag from "../../components/ClassTag.svelte";
  import Icon from "../../components/Icon.svelte";
  import { api, qs } from "../../lib/api.ts";
  import { sourceEvents } from "../../lib/events.svelte.ts";
  import { phaseLabel, working } from "../../lib/working.svelte.ts";
  import { bytes, classificationName, nf, SOURCE_STATUS, WARNING_LABEL, when } from "../../lib/format.ts";
  import { renderMarkdown } from "../../lib/markdown.ts";
  import { session } from "../../lib/session.svelte.ts";
  import type { SourceChunk, SourceDetail } from "../../lib/types.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";

  let { tabId, id, chunk }: { tabId: string; id: string; chunk?: string | undefined } = $props();

  const PAGE = 200;
  let src = $state<SourceDetail | null>(null);
  let chunks = $state<SourceChunk[]>([]);
  let more = $state(false);
  let error = $state("");
  let showOriginal = $state(true);
  let textEl: HTMLDivElement | undefined = $state();
  let busy = $state("");

  const inline = $derived(!!src && /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/(plain|csv|markdown))$/.test(src.mime));
  const canWrite = $derived(!!src && session.vaults.some((v) => v.id === src!.vaultId && v.permission !== "read"));
  const status = $derived(src ? (SOURCE_STATUS[src.status] ?? { label: src.status, tone: "dim" as const }) : null);
  const warnings = $derived(((src?.meta?.warnings as string[] | undefined) ?? []).map((w) => WARNING_LABEL[w] ?? w));

  // the pipeline at work on this document: the steps, the current one, and when it ends a reload
  const STEPS = [
    { level: 0, label: t("Conservato") },
    { level: 1, label: t("Testo cercabile") },
    { level: 2, label: t("Significato") },
    { level: 3, label: t("Pagina compilata") },
  ];
  const work = $derived(src ? working.get(src.id) : undefined);
  let wasWorking = false;
  $effect(() => {
    const w = !!work;
    if (wasWorking && !w && src) untrack(() => void load(src!.id));
    wasWorking = w;
  });

  async function load(sourceId: string) {
    error = "";
    try {
      src = await api.get<SourceDetail>(`/api/sources/${encodeURIComponent(sourceId)}`);
      ws.setTitle(tabId, src.title ?? src.name);
      const ord = chunk ? Number(chunk.split(":").pop()) : 0;
      const first = await api.get<SourceChunk[]>(`/api/sources/${encodeURIComponent(sourceId)}/chunks${qs({ limit: Math.max(PAGE, ord + 50) })}`);
      chunks = first;
      more = first.length >= Math.max(PAGE, ord + 50);
      await tick();
      if (chunk) {
        const el = textEl?.querySelector<HTMLElement>(`[data-chunk="${CSS.escape(chunk)}"]`);
        el?.scrollIntoView({ block: "center" });
        el?.classList.add("flash");
      }
    } catch (e) {
      error = (e as Error).message;
      ws.setTitle(tabId, t("Sorgente non disponibile"));
    }
  }

  async function loadMore() {
    const r = await api.get<SourceChunk[]>(`/api/sources/${encodeURIComponent(id)}/chunks${qs({ offset: chunks.length, limit: PAGE })}`);
    chunks = [...chunks, ...r];
    more = r.length >= PAGE;
  }

  $effect(() => {
    const sid = id;
    untrack(() => void load(sid));
  });
  // live status while the pipeline works on it
  $effect(() => {
    const e = sourceEvents.status[id];
    if (e && src && (e.status !== src.status || e.level !== src.level)) untrack(() => void load(id));
  });

  async function act(kind: "reingest" | "compile") {
    busy = kind;
    try {
      await api.post(`/api/sources/${encodeURIComponent(id)}/${kind}`);
      ui.toast(kind === "compile" ? t("Compilazione messa in coda.") : t("Nuova elaborazione messa in coda."), "ok");
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
</script>

<div class="sv">
  {#if error}
    <div class="empty"><h2>{t("Sorgente non disponibile")}</h2><p>{error}</p></div>
  {:else if !src}
    <div class="pad"><span class="skeleton" style="height:2rem;width:50%"></span></div>
  {:else}
    <header class="head">
      <div class="t">
        <h1>{src.title ?? src.name}</h1>
        <div class="facts">
          <ClassTag level={classificationName(src.classification)} />
          {#if status}<span class="st {status.tone}"><span class="dot {status.tone}"></span>{status.label}</span>{/if}
          <span class="dim">{src.name}</span>
          <span class="dim">{bytes(src.size)}</span>
          {#if src.textTokens}<span class="dim tabular">{t("{textTokens} token", { textTokens: nf.format(src.textTokens) })}</span>{/if}
          <span class="dim">{t("{chunks} parti", { chunks: src.chunks })}</span>
          <span class="dim">{t("caricato {createdAt}", { createdAt: when(src.createdAt) })}</span>
          <span class="dim">{session.vaultName(src.vaultId)}</span>
        </div>
        {#if work}
          <div class="pipeline" role="status" aria-label={t("Lavorazione del documento")}>
            <ol>
              {#each STEPS.filter((st) => st.level < 3 || src!.compile) as st (st.level)}
                <li class:done={src.level >= st.level} class:now={src.level + 1 === st.level}>{st.label}</li>
              {/each}
            </ol>
            <p><span class="spin" aria-hidden="true"></span>{phaseLabel(work)}</p>
          </div>
        {/if}
        {#each warnings as w (w)}<p class="notice warn small">{w}</p>{/each}
        {#if src.error}<p class="notice error small">{src.error}</p>{/if}
      </div>
      <div class="actions">
        {#if src.compiledPage}
          <Button size="sm" onclick={(e) => ws.open({ kind: "page", id: src!.compiledPage! }, target(e))}><Icon name="file" size={14} />{t("Pagina compilata")}</Button>
        {/if}
        <a class="btn-link" href="/api/sources/{encodeURIComponent(src.id)}/original" download={src.name}><Icon name="download" size={14} />{t("Originale")}</a>
        {#if canWrite}
          {#if !src.compiledPage}<Button size="sm" busy={busy === "compile"} onclick={() => act("compile")}>{t("Compila ora")}</Button>{/if}
          <Button size="sm" variant="quiet" busy={busy === "reingest"} onclick={() => act("reingest")}><Icon name="refresh" size={14} />{t("Rielabora")}</Button>
        {/if}
        {#if inline}
          <button class="icon-btn" aria-pressed={showOriginal} title={t("Mostra l'originale")} aria-label={t("Mostra l'originale")} onclick={() => (showOriginal = !showOriginal)}><Icon name="split" /></button>
        {/if}
      </div>
    </header>
    {#if src.children?.length}
      <nav class="children" aria-label={t("Contenuto")}>
        <span class="dim small">{t("Contiene:")}</span>
        {#each src.children as c (c.id)}
          <a class="chip" href="#/sorgente/{c.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "source", id: c.id }, target(e)))}>{c.name}</a>
        {/each}
      </nav>
    {/if}
    <div class="body" class:two={inline && showOriginal}>
      {#if inline && showOriginal}
        <div class="orig">
          {#if src.mime.startsWith("image/")}
            <img src="/api/sources/{encodeURIComponent(src.id)}/original?inline=true" alt={t("Originale: {name}", { name: src.name })} />
          {:else}
            <iframe title={t("Originale: {name}", { name: src.name })} src="/api/sources/{encodeURIComponent(src.id)}/original?inline=true"></iframe>
          {/if}
        </div>
      {/if}
      <div class="text" bind:this={textEl} aria-label={t("Testo estratto")}>
        {#if !chunks.length}
          <p class="dim pad">{["stored", "parsed"].includes(src.status) ? t("Il testo è in elaborazione: appare qui appena è pronto.") : t("Nessun testo estratto da questo documento.")}</p>
        {/if}
        {#each chunks as c (c.id)}
          <section class="chunk" class:cited={c.id === chunk} data-chunk={c.id} id="chunk-{c.ord}">
            <span class="ord mono" title={t("Cita come ^[{id}#c{ord}]", { id: src.id, ord: c.ord })}>c{c.ord}</span>
            {#if c.heading}<p class="hd">{c.heading}</p>{/if}
            <div class="tx md prov-human">{@html renderMarkdown(c.text)}</div>
          </section>
        {/each}
        {#if more}<div class="pad"><Button size="sm" onclick={loadMore}>{t("Mostra altre parti")}</Button></div>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .pipeline {
    margin-top: 0.75rem;
    display: grid;
    gap: 0.4rem;
    font-size: var(--fs-sm);
  }
  .pipeline ol {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .pipeline li {
    padding: 0.15rem 0.6rem;
    border-radius: var(--radius-full);
    background: var(--ink-2);
    color: var(--text-muted);
  }
  .pipeline li.done {
    background: var(--idle-soft);
    color: var(--text-main);
  }
  .pipeline li.done::before {
    content: "✓ ";
  }
  .pipeline li.now {
    background: var(--busy-soft);
    color: var(--text-main);
    font-weight: 600;
  }
  .pipeline p {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-muted);
  }
  .spin {
    width: 0.75rem;
    height: 0.75rem;
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
    .spin {
      animation: none;
    }
  }
  .sv {
    min-height: 0;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  .pad {
    padding: 1.25rem;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.5rem;
    align-items: flex-start;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--line);
  }
  .t {
    flex: 1;
    min-width: 16rem;
    display: grid;
    gap: 0.45rem;
  }
  h1 {
    font-size: var(--fs-xl);
    overflow-wrap: anywhere;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 0.8rem;
    align-items: center;
    font-size: var(--fs-xs);
  }
  .st {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .btn-link {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.6rem;
    border-radius: var(--r-control);
    border: 1px solid var(--line);
    background: var(--ink-2);
    color: var(--text-main);
    text-decoration: none;
    font-size: var(--fs-xs);
    font-weight: 560;
  }
  .btn-link:hover {
    background: var(--ink-3);
  }
  .children {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    padding: 0.5rem 1.25rem;
    border-bottom: 1px solid var(--line);
  }
  .children .chip {
    text-decoration: none;
  }
  .body {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .body.two {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .orig {
    min-height: 0;
    border-right: 1px solid var(--line);
    background: var(--ink-1);
    display: grid;
    overflow: auto;
  }
  .orig iframe {
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }
  .orig img {
    max-width: 100%;
    margin: auto;
  }
  .text {
    min-height: 0;
    overflow-y: auto;
    padding: 0.75rem 1.25rem 4rem;
    display: grid;
    align-content: start;
    gap: 0.25rem;
  }
  .chunk {
    position: relative;
    padding: 0.55rem 0.75rem 0.55rem 3rem;
    border-radius: var(--r-control);
    border: 1px solid transparent;
  }
  .chunk:hover {
    background: var(--ink-1);
  }
  .chunk.cited {
    background: var(--you-soft);
    border-color: var(--you-line);
  }
  .ord {
    position: absolute;
    left: 0.6rem;
    top: 0.65rem;
    font-size: 0.68rem;
    color: var(--text-dim);
  }
  .hd {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 0.2rem;
  }
  /* the extracted text is Markdown (parsers, plan §4.3): rendered safely, html off */
  .tx {
    font-size: var(--fs-md);
    line-height: 1.6;
  }
  .tx > :global(:is(p, ul, ol, h1, h2, h3, h4, h5, h6, blockquote)) {
    max-width: 78ch;
  }
  .tx > :global(:first-child) {
    margin-top: 0;
  }
  .small {
    font-size: var(--fs-xs);
  }
  :global(.chunk.flash) {
    animation: flash 1.6s ease-out;
  }
  @media (max-width: 1000px) {
    .body.two {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 40vh minmax(0, 1fr);
    }
  }
</style>
