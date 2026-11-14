<script lang="ts" generics="T">
  // Fixed-height virtual list: renders only the visible rows (plus a margin), so a folder with
  // a million pages costs the same as one with twenty. `onend` asks for the next page of data.
  import { untrack, type Snippet } from "svelte";

  let {
    items,
    rowHeight = 28,
    maxHeight = 360,
    overscan = 8,
    row,
    onend,
    label,
  }: { items: T[]; rowHeight?: number; maxHeight?: number; overscan?: number; row: Snippet<[T, number]>; onend?: () => void; label?: string } = $props();

  let scrollTop = $state(0);
  let el: HTMLDivElement | undefined = $state();
  const height = $derived(Math.min(maxHeight, items.length * rowHeight));
  const start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = $derived(Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan));
  const visible = $derived(items.slice(start, end));

  function onscroll() {
    scrollTop = el!.scrollTop;
    if (onend && el!.scrollTop + el!.clientHeight > el!.scrollHeight - rowHeight * 10) onend();
  }

  // a short list that does not fill the box still asks for more
  $effect(() => {
    if (onend && items.length && items.length * rowHeight < maxHeight) untrack(() => onend());
  });
</script>

<div class="vl" bind:this={el} {onscroll} style:height="{height}px" role="list" aria-label={label}>
  <div style:height="{items.length * rowHeight}px" class="track">
    {#each visible as item, i (start + i)}
      <div class="row" role="listitem" style:transform="translateY({(start + i) * rowHeight}px)" style:height="{rowHeight}px">
        {@render row(item, start + i)}
      </div>
    {/each}
  </div>
</div>

<style>
  .vl {
    overflow-y: auto;
    overscroll-behavior: contain;
    position: relative;
  }
  .track {
    position: relative;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
  }
</style>
