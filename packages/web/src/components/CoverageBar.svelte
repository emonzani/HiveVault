<script lang="ts">
  import { intlLocale, t } from "../lib/i18n.ts";
  // Ingestion coverage of a space: share of documents at each level (plan §4.1).
  // I1 = searchable by keywords, I2 = + semantic, I3 = compiled into the wiki.
  let { name, total, i1, i2, i3 }: { name: string; total: number; i1: number; i2: number; i3: number } = $props();
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  const fmt = new Intl.NumberFormat(intlLocale);
  // Below 1% show one decimal (0,3%), so a small but real coverage does not read as zero
  const pf = (n: number) => {
    const p = pct(n);
    return p > 0 && p < 1 ? `${p.toLocaleString(intlLocale, { maximumFractionDigits: 1 })}%` : `${p.toFixed(0)}%`;
  };
</script>

<div class="cov">
  <div class="head">
    <span class="name">{name}</span>
    <span class="total tabular">{t("{total} documenti", { total: fmt.format(total) })}</span>
  </div>
  <div class="bar" role="img" aria-label={t("{name}: {i3} compilati, {i2} semantici, {i1} solo parole chiave", { name, i3: pf(i3), i2: pf(i2), i1: pf(i1) })}>
    <span class="seg i3" style:width="{pct(i3)}%"></span>
    <span class="seg i2" style:width="{pct(i2)}%"></span>
    <span class="seg i1" style:width="{pct(i1)}%"></span>
  </div>
  <div class="legend tabular">
    <span><i class="sw i3"></i>{t("Compilati {i3}", { i3: pf(i3) })}</span>
    <span><i class="sw i2"></i>{t("Semantici {i2}", { i2: pf(i2) })}</span>
    <span><i class="sw i1"></i>{t("Parole chiave {i1}", { i1: pf(i1) })}</span>
  </div>
</div>

<style>
  .cov {
    display: grid;
    gap: 0.4rem;
  }
  .head {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: var(--fs-sm);
  }
  .name {
    font-weight: 600;
  }
  .total {
    color: var(--text-dim);
  }
  .bar {
    display: flex;
    height: 0.6rem;
    border-radius: var(--r-pill);
    background: var(--ink-2);
    overflow: hidden;
  }
  .seg {
    height: 100%;
  }
  .seg + .seg {
    box-shadow: -2px 0 0 var(--ink-1);
  }
  .i3 {
    background: var(--cov-i3);
  }
  .i2 {
    background: var(--cov-i2);
  }
  .i1 {
    background: var(--cov-i1);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .sw {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 2px;
    margin-right: 0.35rem;
    vertical-align: 0.02em;
  }
</style>
