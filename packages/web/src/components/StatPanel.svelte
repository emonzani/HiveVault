<script lang="ts">
  import { t } from "../lib/i18n.ts";
  // Dashboard panel: current value, unit, sparkline of the selected time range, and a
  // threshold line. Grafana-style: the number answers "now", the line answers "trend".
  let {
    title,
    value,
    unit = "",
    series,
    threshold,
    status = "ok",
    note,
  }: {
    title: string;
    value: string;
    unit?: string;
    series: number[];
    threshold?: number;
    status?: "ok" | "warn" | "alert";
    note?: string;
  } = $props();

  const W = 240;
  const H = 56;
  const max = $derived(Math.max(...series, threshold ?? 0) * 1.1 || 1);
  const pts = $derived(series.map((v, i) => [(i / (series.length - 1)) * W, H - (v / max) * H] as const));
  const line = $derived(pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
  const area = $derived(`${line} L${W} ${H} L0 ${H} Z`);
  const ty = $derived(threshold === undefined ? undefined : H - (threshold / max) * H);
</script>

<section class="panel {status}">
  <header>
    <h3>{title}</h3>
    {#if status !== "ok"}<span class="state">{status === "warn" ? t("Oltre soglia") : t("Critico")}</span>{/if}
  </header>
  <p class="value tabular">{value}<span class="unit">{unit}</span></p>
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
    <path d={area} class="area" />
    <path d={line} class="line" />
    {#if ty !== undefined}<line x1="0" x2={W} y1={ty} y2={ty} class="thr" />{/if}
  </svg>
  {#if note}<p class="note">{note}</p>{/if}
</section>

<style>
  .panel {
    background: var(--ink-1);
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    padding: 0.8rem 0.9rem 0.7rem;
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .panel.warn {
    border-color: color-mix(in srgb, var(--warn-ink) 40%, transparent);
  }
  .panel.alert {
    border-color: color-mix(in srgb, var(--alert-ink) 45%, transparent);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }
  h3 {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
  }
  .state {
    flex-shrink: 0;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0 0.35rem;
    border-radius: var(--r-pill);
    background: var(--warn-soft);
    color: var(--warn-ink);
  }
  .alert .state {
    background: var(--alert-soft);
    color: var(--alert-ink);
  }
  .value {
    font-size: var(--fs-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .unit {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }
  svg {
    width: 100%;
    height: 3.5rem;
    overflow: visible;
  }
  .line {
    fill: none;
    stroke: var(--series-1);
    stroke-width: 1.6;
    vector-effect: non-scaling-stroke;
  }
  .area {
    fill: color-mix(in srgb, var(--series-1) 14%, transparent);
  }
  .warn .line {
    stroke: var(--warn-ink);
  }
  .warn .area {
    fill: var(--warn-soft);
  }
  .thr {
    stroke: var(--text-dim);
    stroke-dasharray: 3 3;
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .note {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
</style>
