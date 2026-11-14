<script lang="ts">
  // Horizontal bars, largest first: magnitude across categories in one hue (identity is the
  // label beside the bar, not a color). Bars start at zero with a rounded data end, 2px apart;
  // values stay in text ink. Hover shows the exact value and the share of the total.
  import { fmt, type Unit } from "../../lib/metrics.ts";
  import { t } from "../../lib/i18n.ts";

  let { items, unit, color = "var(--series-1)" }: { items: { label: string; value: number }[]; unit: Unit; color?: string } = $props();

  const sorted = $derived([...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value));
  const max = $derived(Math.max(0, ...sorted.map((i) => i.value)) || 1);
  const total = $derived(sorted.reduce((s, i) => s + i.value, 0));
  let hover = $state<string | null>(null);
</script>

<div class="bars" role={sorted.length ? "list" : undefined}>
  {#each sorted as it (it.label)}
    <div class="row" class:dim={hover !== null && hover !== it.label} role="listitem" title="{it.label}: {fmt(it.value, unit)} ({((it.value / total) * 100).toFixed(1).replace('.', ',')}%)" onpointerenter={() => (hover = it.label)} onpointerleave={() => (hover = null)}>
      <span class="lab">{it.label}</span>
      <span class="track"><span class="bar" style="width:{Math.max(1, (it.value / max) * 100)}%;background:{color}"></span></span>
      <span class="val">{fmt(it.value, unit)}</span>
    </div>
  {:else}
    <p class="none">{t("Nessun dato nel periodo.")}</p>
  {/each}
</div>

<style>
  .bars {
    display: grid;
    gap: 2px;
    align-content: start;
    height: 100%;
    overflow-y: auto;
    font-size: var(--fs-xs);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(4rem, 34%) 1fr auto;
    gap: 0.5rem;
    align-items: center;
    min-height: 22px;
    transition: opacity var(--transition-fast);
  }
  .row.dim {
    opacity: 0.45;
  }
  .lab {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track {
    height: 14px;
  }
  .bar {
    display: block;
    height: 100%;
    border-radius: 0 4px 4px 0;
  }
  .val {
    color: var(--text-main);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    min-width: 3.5rem;
    text-align: right;
  }
  .none {
    color: var(--text-dim);
  }
</style>
