<script lang="ts">
  // Hover previews (plan §9.2): over a [[link]] the target page appears in a card after a
  // short pause; over a citation chip the cited source and excerpt appear. One layer for the
  // whole app, driven by event delegation, so rendered pages need no per-link component.
  import { onMount } from "svelte";
  import { current } from "../lib/current.svelte.ts";
  import { classificationName, typeLabel } from "../lib/format.ts";
  import { renderMarkdown, stripHead } from "../lib/markdown.ts";
  import { previewCache } from "../lib/pages.svelte.ts";
  import type { CitationRef, ReadResult } from "../lib/types.ts";
  import ClassTag from "../components/ClassTag.svelte";
  import { t } from "../lib/i18n.ts";

  type Card = { kind: "page"; id: string; data: ReadResult | null; error?: string } | { kind: "cite"; c: CitationRef | null; ref: string };

  let card = $state<Card | null>(null);
  let pos = $state({ x: 0, y: 0, above: false });
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let anchorEl: HTMLElement | null = null;

  function place(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const w = 380;
    const x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    const above = r.bottom + 300 > innerHeight && r.top > 320;
    pos = { x, y: above ? r.top - 8 : r.bottom + 8, above };
  }

  function citationOf(el: HTMLElement): CitationRef | null {
    const tabId = el.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    const ref = el.dataset.cite!;
    return (tabId ? current.byTab[tabId]?.page.citations.find((c) => c.ref === ref) : undefined) ?? null;
  }

  function open(el: HTMLElement) {
    anchorEl = el;
    place(el);
    if (el.matches("button.cite")) {
      card = { kind: "cite", c: citationOf(el), ref: el.dataset.cite! };
      return;
    }
    const id = el.dataset.page!;
    const cached = previewCache.peek(id);
    card = { kind: "page", id, data: cached ?? null };
    if (!cached) {
      previewCache.get(id).then(
        (d) => card?.kind === "page" && card.id === id && (card = { kind: "page", id, data: d }),
        () => card?.kind === "page" && card.id === id && (card = { kind: "page", id, data: null, error: t("Anteprima non disponibile.") }),
      );
    }
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => ((card = null), (anchorEl = null)), 160);
  }

  onMount(() => {
    const over = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.closest?.(".hover-card")) {
        clearTimeout(hideTimer);
        return;
      }
      const el = t.closest?.<HTMLElement>(".md a.wl[data-page], .md button.cite");
      if (!el) {
        if (card) scheduleHide();
        return;
      }
      if (el === anchorEl) {
        clearTimeout(hideTimer);
        return;
      }
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      showTimer = setTimeout(() => open(el), el.matches("button.cite") ? 120 : 380);
    };
    const focusIn = (e: Event) => {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>(".md a.wl[data-page], .md button.cite");
      if (el) open(el);
    };
    const away = () => card && scheduleHide();
    const key = (e: KeyboardEvent) => e.key === "Escape" && card && ((card = null), (anchorEl = null));
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", away);
    document.addEventListener("scroll", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", away);
      document.removeEventListener("scroll", away, true);
      document.removeEventListener("keydown", key);
    };
  });

  const previewHtml = $derived(card?.kind === "page" && card.data ? renderMarkdown(stripHead(card.data.content)) : "");
</script>

{#if card}
  <div class="hover-card" role="tooltip" style:left="{pos.x}px" style:top="{pos.y}px" class:above={pos.above}>
    {#if card.kind === "page"}
      {#if card.data}
        <div class="h">
          <strong>{card.data.title}</strong>
          <ClassTag level={classificationName(card.data.classification)} />
        </div>
        <p class="t">{typeLabel(card.data.type)}</p>
        {#if card.data.tldr}<p class="tldr">{card.data.tldr}</p>{/if}
        <div class="md mini">{@html previewHtml}</div>
        {#if card.data.truncated}<p class="more">{t("Continua nella pagina…")}</p>{/if}
      {:else if card.error}
        <p class="dim">{card.error}</p>
      {:else}
        <span class="skeleton" style="height:1rem;width:60%"></span>
        <span class="skeleton" style="height:3rem;width:100%;margin-top:0.6rem"></span>
      {/if}
    {:else if card.c && card.c.kind !== "unknown"}
      <div class="h"><strong>{card.c.name ?? card.c.id}</strong></div>
      <p class="t mono">{card.c.chunkId ?? card.c.id}</p>
      {#if card.c.excerpt}<p class="ex prov-human">«{card.c.excerpt}»</p>{/if}
      <p class="more">{t("Clic per aprire la fonte")}</p>
    {:else}
      {#if /^(ent|cpt|dec|syn|pag|spg)_/.test(card.ref)}
        <p class="dim">{t("Pagina di una cella a cui non hai accesso: l'informazione viene da lì.")}</p>
      {:else}
        <p class="missing">{t("Fonte non trovata o non accessibile:")} <span class="mono">{card.ref}</span></p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .hover-card {
    position: fixed;
    z-index: 90;
    width: 380px;
    max-height: 300px;
    overflow: hidden;
    padding: 0.85rem 1rem;
    border-radius: var(--r-panel);
    border: 1px solid var(--line-strong);
    background: var(--ink-1);
    box-shadow: var(--shadow-subtle), 0 18px 48px rgba(0, 0, 0, 0.3);
    animation: in 0.12s ease-out;
    display: grid;
    gap: 0.35rem;
    align-content: start;
  }
  .hover-card.above {
    transform: translateY(-100%);
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
  .h {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    justify-content: space-between;
  }
  .t {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .tldr {
    font-size: var(--fs-sm);
    padding-left: 0.6rem;
    border-left: 2px solid var(--busy);
  }
  .mini {
    font-size: var(--fs-sm);
    line-height: 1.5;
    mask-image: linear-gradient(#000 70%, transparent);
  }
  .mini :global(h2) {
    font-size: var(--fs-sm);
    border: 0;
    margin-top: 0.6em;
  }
  .ex {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .more {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .missing {
    font-size: var(--fs-sm);
    color: var(--alert-ink);
  }
</style>
