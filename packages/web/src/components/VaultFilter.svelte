<script lang="ts">
  // Filter by vault that stays small with 1000 vaults: the bar shows "Tutti i vault", the chosen
  // vaults (the first few) and one button; the button opens a panel with a search field and a
  // virtual list of check boxes. No vault chosen = every readable vault.
  import { intlLocale, t } from "../lib/i18n.ts";
  import type { Vault } from "../lib/types.ts";
  import Icon from "./Icon.svelte";
  import VirtualList from "./VirtualList.svelte";

  let {
    selected = $bindable([]),
    vaults,
    swatch,
    count,
    eyebrow = false,
  }: {
    selected?: string[];
    vaults: Vault[];
    /** CSS color of a vault, shown as a dot. */
    swatch?: (id: string) => string;
    /** Number shown next to a vault (for example the hits in it); vaults with a number come first. */
    count?: (id: string) => number | undefined;
    eyebrow?: boolean;
  } = $props();

  const CHIPS = 4;
  const uid = $props.id();
  const panelId = `vf-${uid}`;
  let open = $state(false);
  let query = $state("");
  let root = $state<HTMLDivElement>();
  let toggleBtn = $state<HTMLButtonElement>();
  let field = $state<HTMLInputElement>();

  const byId = $derived(new Map(vaults.map((v) => [v.id, v])));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const sorted = $derived(
    [...vaults].sort((a, b) => (count ? (count(b.id) ?? 0) - (count(a.id) ?? 0) : 0) || a.name.localeCompare(b.name, intlLocale)),
  );
  const found = $derived.by(() => {
    const q = fold(query.trim());
    return q ? sorted.filter((v) => fold(v.name).includes(q) || v.slug.includes(q)) : sorted;
  });
  const allFound = $derived(found.length > 0 && found.every((v) => selected.includes(v.id)));

  const toggle = (id: string) => (selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  function toggleFound() {
    const ids = new Set(found.map((v) => v.id));
    selected = allFound ? selected.filter((id) => !ids.has(id)) : [...selected, ...found.map((v) => v.id).filter((id) => !selected.includes(id))];
  }

  function show(v: boolean) {
    open = v;
    if (v) queueMicrotask(() => field?.focus());
    else query = "";
  }
  function onkeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape" && root?.contains(document.activeElement)) {
      e.preventDefault();
      show(false);
      toggleBtn?.focus();
    }
  }
  function onfieldkey(e: KeyboardEvent) {
    // Enter picks the only match, or the first one
    if (e.key === "Enter" && found[0]) {
      e.preventDefault();
      toggle(found[0].id);
    }
  }

  // a click outside the filter closes the panel
  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) show(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  });
</script>

<svelte:window {onkeydown} />

<div class="vf" role="group" aria-label={t("Vault")} bind:this={root}>
  {#if eyebrow}<span class="eyebrow lbl">{t("Vault")}</span>{/if}
  <button class="chip" aria-pressed={!selected.length} onclick={() => (selected = [])}>{t("Tutti i vault")} <span class="n">{vaults.length}</span></button>
  {#each selected.slice(0, CHIPS) as id (id)}
    <button class="chip" aria-pressed="true" aria-label={t("Togli {name} dal filtro", { name: name(id) })} onclick={() => toggle(id)}>
      {#if swatch}<span class="sw" style="background:{swatch(id)}" aria-hidden="true"></span>{/if}{name(id)}{#if count?.(id)}<span class="n">{count(id)}</span>{/if}
      <span class="x" aria-hidden="true">×</span>
    </button>
  {/each}
  {#if selected.length > CHIPS}<span class="more">{t("e altri {x}", { x: selected.length - CHIPS })}</span>{/if}
  <button class="chip pick" bind:this={toggleBtn} aria-expanded={open} aria-controls={panelId} onclick={() => show(!open)}>
    <Icon name="search" size={12} />{t("Scegli i vault")}
  </button>

  {#if open}
    <div class="pop" id={panelId} role="dialog" aria-label={t("Scegli i vault")}>
      <input bind:this={field} bind:value={query} class="input" type="search" placeholder={t("Cerca un vault…")} aria-label={t("Cerca un vault…")} autocomplete="off" onkeydown={onfieldkey} />
      <div class="bar">
        <span class="dim" role="status">{t("{n} vault", { n: found.length })}</span>
        {#if found.length}
          <button class="link" onclick={toggleFound}>{allFound ? t("Togli i vault trovati") : t("Scegli i vault trovati")}</button>
        {/if}
      </div>
      {#if found.length}
        <VirtualList items={found} rowHeight={32} maxHeight={320} label={t("Scegli i vault")}>
          {#snippet row(v: Vault)}
            <label class="opt">
              <input type="checkbox" checked={selected.includes(v.id)} onchange={() => toggle(v.id)} />
              {#if swatch}<span class="sw" style="background:{swatch(v.id)}" aria-hidden="true"></span>{/if}
              <span class="nm">{v.name}</span>
              {#if count?.(v.id)}<span class="n">{count(v.id)}</span>{/if}
              <span class="h">{v.kind === "space" ? t("alveare") : t("cella")}</span>
            </label>
          {/snippet}
        </VirtualList>
      {:else}
        <p class="dim none">{t("Nessun risultato.")}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vf {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
  }
  .lbl {
    margin-right: 0.35rem;
  }
  .sw {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
  }
  .chip {
    max-width: 14rem;
  }
  .x {
    margin-left: 0.15rem;
    opacity: 0.7;
  }
  .more {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .pick {
    color: var(--text-main);
  }
  .pop {
    position: absolute;
    z-index: 30;
    top: calc(100% + 0.35rem);
    left: 0;
    width: min(22rem, calc(100vw - 2rem));
    display: grid;
    gap: 0.45rem;
    padding: 0.55rem;
    background: var(--ink-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--shadow-modal);
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--fs-xs);
  }
  .dim {
    color: var(--text-dim);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent-blue);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    height: 100%;
    padding: 0 0.4rem;
    border-radius: 6px;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .opt:hover {
    background: var(--ink-2);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .h {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    font-family: var(--font-mono);
  }
  .none {
    margin: 0;
    padding: 0.3rem 0.4rem;
    font-size: var(--fs-sm);
  }
</style>
