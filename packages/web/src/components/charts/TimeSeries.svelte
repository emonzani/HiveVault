<script lang="ts" module>
  import { t } from "../../lib/i18n.ts";
  export interface Line {
    key: string;
    label: string;
    /** CSS color (a series token): fixed by the entity, never by rank. */
    color: string;
    points: [number, number | null][];
  }
</script>

<script lang="ts">
  // Time series on one y axis from zero: 2px lines (a gap where data is missing), a light area
  // under a single series, crosshair and tooltip on hover, a legend for two or more series
  // (a click hides or shows a series; the others keep their colors).
  import { fmt, fullTime, niceTicks, timeLabel, type Unit } from "../../lib/metrics.ts";

  let { lines, unit, from, to }: { lines: Line[]; unit: Unit; from: number; to: number } = $props();

  let w = $state(0);
  let h = $state(0);
  let hidden = $state(new Set<string>());
  let hover = $state<{ t: number; x: number } | null>(null);

  const M = { l: 52, r: 12, t: 10, b: 22 };
  const shown = $derived(lines.filter((l) => !hidden.has(l.key)));
  const legend = $derived(lines.length >= 2);
  const plotH = $derived(Math.max(10, h - (legend ? 26 : 0)));
  const iw = $derived(Math.max(10, w - M.l - M.r));
  const ih = $derived(Math.max(10, plotH - M.t - M.b));
  const max = $derived(Math.max(0, ...shown.flatMap((l) => l.points.map((p) => p[1] ?? 0))));
  const ticks = $derived(niceTicks(max));
  const top = $derived(ticks.at(-1)! || 1);
  const x = (t: number) => M.l + ((t - from) / Math.max(1, to - from)) * iw;
  const y = (v: number) => M.t + ih - (v / top) * ih;

  function path(pts: [number, number | null][]): string {
    let d = "";
    let pen = false;
    for (const [t, v] of pts) {
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  }
  function area(pts: [number, number | null][]): string {
    const real = pts.filter((p) => p[1] !== null) as [number, number][];
    if (real.length < 2) return "";
    return `${path(real)} L${x(real.at(-1)![0]).toFixed(1)} ${y(0)} L${x(real[0]![0]).toFixed(1)} ${y(0)} Z`;
  }
  const xTicks = $derived.by(() => {
    const n = Math.max(2, Math.min(7, Math.floor(iw / 110)));
    return Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 0.5)) / n);
  });
  const times = $derived([...new Set(shown.flatMap((l) => l.points.map((p) => p[0])))].sort((a, b) => a - b));

  function onMove(e: PointerEvent) {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const t = from + ((e.clientX - r.left) / r.width) * (to - from);
    let best = times[0];
    for (const c of times) if (Math.abs(c - t) < Math.abs((best ?? c) - t)) best = c;
    hover = best === undefined ? null : { t: best, x: x(best) };
  }
  const at = (l: Line, t: number) => l.points.find((p) => p[0] === t)?.[1] ?? null;
  const tip = $derived(
    hover
      ? shown
          .map((l) => ({ l, v: at(l, hover!.t) }))
          .filter((r) => r.v !== null)
          .sort((a, b) => b.v! - a.v!)
      : [],
  );
  function toggle(k: string) {
    const n = new Set(hidden);
    if (n.has(k)) n.delete(k);
    else if (n.size < lines.length - 1) n.add(k);
    hidden = n;
  }
</script>

<div class="ts" bind:clientWidth={w} bind:clientHeight={h}>
  {#if w > 0 && h > 0}
    <svg width={w} height={plotH} role="img" aria-label={t("Grafico nel tempo: {join}", { join: lines.map((l) => l.label).join(', ') })}>
      {#each ticks as t (t)}
        <line class="grid" x1={M.l} x2={w - M.r} y1={y(t)} y2={y(t)} />
        <text class="ax" x={M.l - 6} y={y(t)} text-anchor="end" dominant-baseline="middle">{fmt(t, unit)}</text>
      {/each}
      {#each xTicks as t (t)}
        <text class="ax" x={x(t)} y={plotH - 6} text-anchor="middle">{timeLabel(t, to - from)}</text>
      {/each}
      {#if shown.length === 1}
        <path d={area(shown[0]!.points)} fill={shown[0]!.color} class="area" />
      {/if}
      {#each shown as l (l.key)}
        <path d={path(l.points)} stroke={l.color} class="line" />
        {#if l.points.filter((p) => p[1] !== null).length === 1}
          {@const p = l.points.find((q) => q[1] !== null)!}
          <circle cx={x(p[0])} cy={y(p[1]!)} r="4" fill={l.color} class="ring" />
        {/if}
      {/each}
      {#if hover}
        <line class="cross" x1={hover.x} x2={hover.x} y1={M.t} y2={M.t + ih} />
        {#each tip as r (r.l.key)}
          <circle cx={hover.x} cy={y(r.v!)} r="4" fill={r.l.color} class="ring" />
        {/each}
      {/if}
      <rect class="hit" x={M.l} y={M.t} width={iw} height={ih} onpointermove={onMove} onpointerleave={() => (hover = null)} role="presentation" />
    </svg>
    {#if hover && tip.length}
      <div class="tip" style="left:{Math.min(hover.x + 12, w - 190)}px;top:{M.t}px" role="status">
        <div class="tt">{fullTime(hover.t)}</div>
        {#each tip as r (r.l.key)}
          <div class="tr"><span class="sw" style="background:{r.l.color}"></span><span class="tl">{r.l.label}</span><span class="tv">{fmt(r.v, unit)}</span></div>
        {/each}
      </div>
    {/if}
    {#if legend}
      <div class="legend" role="group" aria-label={t("Serie")}>
        {#each lines as l (l.key)}
          <button class:off={hidden.has(l.key)} aria-pressed={!hidden.has(l.key)} onclick={() => toggle(l.key)}><span class="sw" style="background:{l.color}"></span>{l.label}</button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .ts {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  svg {
    display: block;
  }
  .grid {
    stroke: var(--line);
    stroke-width: 1;
  }
  .ax {
    fill: var(--text-dim);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }
  .line {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .area {
    opacity: 0.12;
  }
  .ring {
    stroke: var(--ink-1);
    stroke-width: 2;
  }
  .cross {
    stroke: var(--line-strong);
    stroke-width: 1;
  }
  .hit {
    fill: transparent;
    cursor: crosshair;
  }
  .tip {
    position: absolute;
    min-width: 11rem;
    max-width: 16rem;
    pointer-events: none;
    background: var(--ink-0);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    padding: 0.45rem 0.55rem;
    box-shadow: var(--shadow-subtle);
    font-size: var(--fs-xs);
    display: grid;
    gap: 0.2rem;
    z-index: 2;
  }
  .tt {
    color: var(--text-muted);
  }
  .tr {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.4rem;
    align-items: center;
  }
  .tl {
    color: var(--text-main);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tv {
    color: var(--text-main);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .sw {
    width: 10px;
    height: 3px;
    border-radius: 2px;
    display: inline-block;
  }
  .legend {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.2rem 0.75rem;
    height: 26px;
    align-items: center;
    overflow-x: auto;
    padding: 0 0.25rem;
    scrollbar-width: none;
  }
  .legend button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
    padding: 0.1rem 0;
  }
  .legend button.off {
    opacity: 0.4;
  }
  .legend button:hover {
    color: var(--text-main);
  }
</style>
