<script lang="ts">
  // One folder of the sidebar: loads pages in title order, 200 at a time, as the list scrolls.
  import { untrack } from "svelte";
  import VirtualList from "../components/VirtualList.svelte";
  import { api, qs } from "../lib/api.ts";
  import { prefetch } from "../lib/pages.svelte.ts";
  import type { PageListItem } from "../lib/types.ts";
  import { target } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { t } from "../lib/i18n.ts";

  let { vaultId, folder, count, reload = 0 }: { vaultId: string; folder: string; count: number; reload?: number } = $props();

  let items = $state<PageListItem[]>([]);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let done = $state(false);
  let error = $state("");

  const activeId = $derived(ws.tab.view.kind === "page" ? ws.tab.view.id : null);

  async function more() {
    if (loading || done) return;
    loading = true;
    try {
      const r = await api.get<{ items: PageListItem[]; next: string | null }>(`/api/vaults/${encodeURIComponent(vaultId)}/pages${qs({ folder, cursor: next, limit: 200 })}`);
      items = [...items, ...r.items];
      next = r.next;
      done = !r.next;
    } catch (e) {
      error = (e as Error).message;
      done = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void reload;
    void vaultId;
    items = [];
    next = null;
    done = false;
    error = "";
    untrack(() => void more());
  });
</script>

{#if error}
  <p class="err">{error}</p>
{:else if !items.length && loading}
  <div class="sk"><span class="skeleton" style="height:0.8rem;width:70%"></span><span class="skeleton" style="height:0.8rem;width:55%"></span></div>
{:else}
  <VirtualList {items} rowHeight={28} maxHeight={count > 14 ? 392 : count * 28 + 2} onend={more} label={t("Pagine")}>
    {#snippet row(p: PageListItem)}
      <a
        class="item"
        class:active={p.id === activeId}
        href="#/p/{p.id}"
        title={p.title}
        onclick={(e) => {
          e.preventDefault();
          ws.open({ kind: "page", id: p.id }, target(e));
        }}
        onauxclick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            ws.open({ kind: "page", id: p.id }, "tab");
          }
        }}
        onmouseenter={() => prefetch(p.id)}
      >
        {p.title}
      </a>
    {/snippet}
  </VirtualList>
{/if}

<style>
  .item {
    display: block;
    height: 28px;
    line-height: 28px;
    padding: 0 0.6rem 0 1.85rem;
    border-radius: 6px;
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--fs-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item:hover {
    background: var(--ink-2);
    color: var(--text-main);
  }
  .item.active {
    background: var(--ink-3);
    color: var(--text-main);
  }
  .sk {
    display: grid;
    gap: 0.5rem;
    padding: 0.4rem 0 0.4rem 1.85rem;
  }
  .err {
    padding: 0.3rem 0 0.3rem 1.85rem;
    font-size: var(--fs-xs);
    color: var(--alert-ink);
  }
</style>
