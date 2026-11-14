<script lang="ts">
  // Dashboard engine (plan §8.4): global time range, auto refresh, variables, one batched
  // metrics query per load, panels on a 12-column grid that the viewer can move and resize
  // (layout kept per viewer in localStorage), a table view for every chart, drill-down links.
  import { untrack } from "svelte";
  import Explain from "../../components/Explain.svelte";
  import { EXPLAIN_DASHBOARD } from "../../lib/explain.ts";
  import Bars from "../../components/charts/Bars.svelte";
  import TimeSeries, { type Line } from "../../components/charts/TimeSeries.svelte";
  import Icon from "../../components/Icon.svelte";
  import { api } from "../../lib/api.ts";
  import type { AdminVault } from "../../lib/admin.ts";
  import { DASHBOARDS, type Dashboard, type Panel, type Place } from "../../lib/dashboards.ts";
  import { ALL_CLASSIFICATIONS, nf } from "../../lib/format.ts";
  import { fmt, MAX_SERIES, RANGES, REFRESH, SERIES_VARS, seriesLabel, type MetricQ, type QueryResult, type RangeId } from "../../lib/metrics.ts";
  import { session } from "../../lib/session.svelte.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { inSentence, intlLocale, t } from "../../lib/i18n.ts";

  let { tabId, id }: { tabId: string; id: string } = $props();
  const dash = $derived<Dashboard>(DASHBOARDS.find((d) => d.id === id) ?? DASHBOARDS[0]!);
  $effect(() => ws.setTitle(tabId, t("Dashboard · {title}", { title: dash.title })));

  // --- preferences of this viewer ----------------------------------------------------------
  const uid = session.me?.principal.id ?? "anon";
  const read = <T,>(k: string, d: T): T => {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  };
  const write = (k: string, v: unknown) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  };
  let range = $state<RangeId>(read(`cb-dash-range-${uid}`, "24h"));
  let refresh = $state<number>(read(`cb-dash-refresh-${uid}`, 60));
  let vars = $state<Record<string, string>>(read(`cb-dash-vars-${uid}`, {}));
  $effect(() => write(`cb-dash-range-${uid}`, range));
  $effect(() => write(`cb-dash-refresh-${uid}`, refresh));
  $effect(() => write(`cb-dash-vars-${uid}`, vars));

  // --- layout --------------------------------------------------------------------------------
  const COLS = 12;
  const ROW = 64;
  const GAP = 12;
  const layoutKey = (d: string) => `cb-dash-layout-${uid}-${d}`;
  const defaults = (d: Dashboard) => Object.fromEntries(d.panels.map((p) => [p.id, { ...p.at }])) as Record<string, Place>;
  function loadLayout(d: Dashboard): Record<string, Place> {
    const saved = read<Record<string, Place>>(layoutKey(d.id), {});
    const out = defaults(d);
    for (const [k, v] of Object.entries(saved)) if (out[k] && v && [v.x, v.y, v.w, v.h].every(Number.isFinite)) out[k] = v;
    return out;
  }
  let layout = $state<Record<string, Place>>({});
  $effect(() => {
    const d = dash;
    untrack(() => (layout = loadLayout(d)));
  });
  let editing = $state(false);
  const hit = (a: Place, b: Place) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  /** Puts `id` at `place`; panels in the way move down, then everything rises into free rows. */
  function place(cur: Record<string, Place>, id: string, p: Place): Record<string, Place> {
    const moved = { ...p };
    const others = Object.entries(cur)
      .filter(([k]) => k !== id)
      .map(([k, v]) => ({ k, v: { ...v } }))
      .sort((a, b) => a.v.y - b.v.y || a.v.x - b.v.x);
    const placed: Place[] = [moved];
    for (const o of others) {
      while (placed.some((q) => hit(q, o.v))) o.v.y++;
      placed.push(o.v);
    }
    for (const o of others) {
      while (o.v.y > 0 && !placed.some((q) => q !== o.v && hit(q, { ...o.v, y: o.v.y - 1 }))) o.v.y--;
    }
    return { [id]: moved, ...Object.fromEntries(others.map((o) => [o.k, o.v])) };
  }
  let gridW = $state(0);
  /** Columns follow the width of the grid itself (the sidebars change it, not only the window). */
  const cols = $derived(gridW >= 760 ? 12 : gridW >= 480 ? 6 : 1);
  /**
   * The places shown: the 12-column layout as it is, or derived from it for 6 or 1 columns
   * (reading order kept, every panel at the first free row). Editing works at 12 columns.
   */
  const shown = $derived.by(() => {
    if (cols === 12) return layout;
    const order = Object.entries(layout).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x);
    const out: Record<string, Place> = {};
    const taken: Place[] = [];
    for (const [k, p] of order) {
      const w = cols === 1 ? 1 : Math.min(6, Math.max(2, Math.ceil(p.w / 2)));
      const x = cols === 1 ? 0 : Math.min(6 - w, Math.floor(p.x / 2));
      const q = { x, y: 0, w, h: cols === 1 ? Math.max(2, Math.min(p.h, 5)) : p.h };
      while (taken.some((t) => hit(t, q))) q.y++;
      taken.push(q);
      out[k] = q;
    }
    return out;
  });
  $effect(() => {
    if (cols !== 12) editing = false;
  });
  let drag: { id: string; mode: "move" | "size"; x0: number; y0: number; orig: Place } | null = null;
  function startDrag(e: PointerEvent, id: string, mode: "move" | "size") {
    if (!editing || e.button !== 0) return;
    e.preventDefault();
    drag = { id, mode, x0: e.clientX, y0: e.clientY, orig: { ...layout[id]! } };
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", endDrag, { once: true });
  }
  function onDrag(e: PointerEvent) {
    if (!drag) return;
    const colW = (gridW + GAP) / COLS;
    const dc = Math.round((e.clientX - drag.x0) / colW);
    const dr = Math.round((e.clientY - drag.y0) / (ROW + GAP));
    const o = drag.orig;
    const p =
      drag.mode === "move"
        ? { ...o, x: Math.max(0, Math.min(COLS - o.w, o.x + dc)), y: Math.max(0, o.y + dr) }
        : { ...o, w: Math.max(2, Math.min(COLS - o.x, o.w + dc)), h: Math.max(2, o.h + dr) };
    const cur = layout[drag.id]!;
    if (p.x !== cur.x || p.y !== cur.y || p.w !== cur.w || p.h !== cur.h) layout = place(layout, drag.id, p);
  }
  function endDrag() {
    window.removeEventListener("pointermove", onDrag);
    drag = null;
    write(layoutKey(dash.id), layout);
  }
  /** Keyboard: arrows move the focused panel, Shift+arrows resize it. */
  function onPanelKey(e: KeyboardEvent, id: string) {
    if (!editing || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    const o = layout[id]!;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0];
    const p = e.shiftKey
      ? { ...o, w: Math.max(2, Math.min(COLS - o.x, o.w + d[0]!)), h: Math.max(2, o.h + d[1]!) }
      : { ...o, x: Math.max(0, Math.min(COLS - o.w, o.x + d[0]!)), y: Math.max(0, o.y + d[1]!) };
    layout = place(layout, id, p);
    write(layoutKey(dash.id), layout);
  }
  function resetLayout() {
    layout = defaults(dash);
    try {
      localStorage.removeItem(layoutKey(dash.id));
    } catch {
      /* ignore */
    }
  }

  // --- variables -------------------------------------------------------------------------------
  let vaults = $state<AdminVault[]>([]);
  $effect(() => {
    if (dash.vars?.length && !vaults.length) api.get<AdminVault[]>("/api/admin/vaults").then((v) => (vaults = v), () => {});
  });
  const options = (from: "spaces" | "vaults") => vaults.filter((v) => from === "vaults" || v.kind === "space");
  const vaultName = $derived(new Map(vaults.map((v) => [v.id, v.name])));
  /** "$name" values of a match become the variable's value; "all" drops the condition. */
  function bind(q: MetricQ): MetricQ {
    if (!q.match) return q;
    const match: Record<string, string> = {};
    for (const [k, v] of Object.entries(q.match)) {
      if (!v.startsWith("$")) match[k] = v;
      else if (vars[v.slice(1)]) match[k] = vars[v.slice(1)]!;
    }
    return { ...q, match };
  }

  /** One batched request for all the metric panels of the dashboard. */
  async function runQueries(queries: (MetricQ & { id: string })[], from: Date, to: Date, points: number): Promise<{ tookMs: number; results: QueryResult[] }> {
    if (!queries.length) return { tookMs: 0, results: [] };
    return api.post("/api/admin/metrics/query", {
      from: from.toISOString(),
      to: to.toISOString(),
      points,
      queries: queries.map(({ id, name, agg, match, groupBy }) => ({ id, name, agg, ...(match && Object.keys(match).length ? { match } : {}), ...(groupBy ? { groupBy } : {}) })),
    });
  }

  // --- data -----------------------------------------------------------------------------------
  let results = $state(new Map<string, QueryResult>());
  let stats = $state(new Map<string, unknown>());
  let window_ = $state({ from: 0, to: 0 });
  let loading = $state(false);
  let error = $state("");
  let updated = $state<{ at: Date; ms: number } | null>(null);
  let seq = 0;

  const metricQueries = (d: Dashboard) =>
    d.panels.flatMap((p) => {
      const qs = p.kind === "timeseries" ? p.queries : p.kind === "bars" ? [p.q] : p.kind === "stat" && p.q ? [p.q] : [];
      return qs.map((q, i) => ({ id: `${p.id}:${i}`, ...bind(q) }));
    });
  const statNames = (d: Dashboard) => [...new Set(d.panels.flatMap((p) => (p.kind === "table" ? [p.stat] : p.kind === "stat" && p.stat ? [p.stat.name] : [])))];

  async function load() {
    const my = ++seq;
    const d = dash;
    const to = Date.now();
    const from = to - RANGES.find((r) => r.id === range)!.ms;
    loading = true;
    try {
      const [m, s] = await Promise.all([
        runQueries(metricQueries(d), new Date(from), new Date(to), Math.min(400, Math.max(60, Math.round(gridW / 3) || 300))),
        Promise.all(statNames(d).map(async (n) => [n, await api.get<unknown>(`/api/admin/stats/${n}`).catch(() => null)] as const)),
      ]);
      if (my !== seq) return;
      results = new Map(m.results.map((r) => [r.id, r]));
      stats = new Map(s);
      window_ = { from, to };
      updated = { at: new Date(), ms: m.tookMs };
      error = "";
    } catch (e) {
      if (my === seq) error = (e as Error).message;
    } finally {
      if (my === seq) loading = false;
    }
  }
  $effect(() => {
    void [dash, range, JSON.stringify(vars)];
    untrack(() => void load());
  });
  $effect(() => {
    if (!refresh) return;
    const t = setInterval(() => document.visibilityState === "visible" && void load(), refresh * 1000);
    return () => clearInterval(t);
  });

  // --- panel data ------------------------------------------------------------------------------
  /** Lines of a time series panel: colors by entity (labels in a stable order); beyond six, "Altri". */
  function linesOf(p: Panel & { kind: "timeseries" }): Line[] {
    let raw = p.queries.flatMap((q, i) =>
      (results.get(`${p.id}:${i}`)?.series ?? []).map((s) => ({ key: `${i}|${JSON.stringify(s.labels)}`, label: seriesLabel(q, s, q.label ?? p.title), points: s.points })),
    );
    if (p.queries.length === 1) raw = raw.sort((a, b) => a.label.localeCompare(b.label, intlLocale));
    if (raw.length > MAX_SERIES) {
      const tot = (l: (typeof raw)[number]) => l.points.reduce((s, x) => s + (x[1] ?? 0), 0);
      const keep = new Set([...raw].sort((a, b) => tot(b) - tot(a)).slice(0, MAX_SERIES - 1).map((l) => l.key));
      const rest = raw.filter((l) => !keep.has(l.key));
      const sum = new Map<number, number>();
      for (const l of rest) for (const [t, v] of l.points) if (v !== null) sum.set(t, (sum.get(t) ?? 0) + v);
      raw = [...raw.filter((l) => keep.has(l.key)), { key: "altri", label: t("Altri ({n})", { n: rest.length }), points: [...sum.entries()].sort((a, b) => a[0] - b[0]) }];
    }
    return raw.map((l, i) => ({ ...l, label: niceLabel(l.label), color: `var(${SERIES_VARS[i % SERIES_VARS.length]})` }));
  }
  /** Ids of vaults in labels (hive spaces) read better as names. */
  const niceLabel = (s: string) => vaultName.get(s) ?? LABELS[s] ?? s;
  const LABELS: Record<string, string> = { "2xx": t("riuscite (2xx)"), "3xx": t("redirect (3xx)"), "4xx": t("errori del client (4xx)"), "5xx": t("errori del server (5xx)"), ok: t("riuscite"), denied: t("negate"), error: t("errori"), hit: t("dalla cache"), miss: t("calcolate"), hits: t("con risultati"), empty: t("senza risultati"), written: t("aggiornate"), unchanged: t("invariate"), web: t("app web"), mcp: t("Agente cloud (MCP)"), rx: t("in entrata"), tx: t("in uscita") };

  function barsOf(p: Panel & { kind: "bars" }) {
    return (results.get(`${p.id}:0`)?.series ?? []).map((s) => {
      const vals = s.points.map((x) => x[1]).filter((v): v is number => v !== null);
      return { label: niceLabel(seriesLabel(p.q, s, p.title)), value: p.reduce === "sum" ? vals.reduce((a, b) => a + b, 0) : (vals.at(-1) ?? 0) };
    });
  }
  function statOf(p: Panel & { kind: "stat" }): { value: number | null; spark: number[] } {
    if (p.stat) {
      const v = (stats.get(p.stat.name) as Record<string, unknown> | null)?.[p.stat.field];
      return { value: typeof v === "number" ? v : null, spark: [] };
    }
    const s = results.get(`${p.id}:0`)?.series[0];
    if (!s) return { value: null, spark: [] };
    const vals = s.points.map((x) => x[1]);
    const real = vals.filter((v): v is number => v !== null);
    return { value: p.total ? real.reduce((a, b) => a + b, 0) : (real.at(-1) ?? null), spark: vals.map((v) => v ?? 0) };
  }
  function level(p: Panel & { kind: "stat" }, v: number | null): "ok" | "warn" | "alert" {
    if (v === null) return "ok";
    const bad = (t: number | undefined) => t !== undefined && (p.lowIsBad ? v <= t : v >= t);
    return bad(p.alert) ? "alert" : bad(p.warn) ? "warn" : "ok";
  }
  function rowsOf(p: Panel & { kind: "table" }): Record<string, unknown>[] {
    const s = stats.get(p.stat) as unknown;
    const v = p.path ? (s as Record<string, unknown> | null)?.[p.path] : s;
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }
  function cell(v: unknown, unit?: string): string {
    if (v === null || v === undefined || v === "") return "—";
    if (unit === "date") return new Date(String(v)).toLocaleString(intlLocale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    if (unit === "class") return ALL_CLASSIFICATIONS[Number(v)] ?? String(v);
    if (unit && unit !== "text" && typeof v === "number") return fmt(v, unit as never);
    if (Array.isArray(v)) return v.join(", ");
    return typeof v === "number" ? nf.format(v) : String(v);
  }
  function spark(vals: number[]): string {
    if (vals.length < 2) return "";
    const m = Math.max(...vals) || 1;
    return vals.map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * 100).toFixed(2)} ${(28 - (v / m) * 26).toFixed(2)}`).join(" ");
  }

  let tableView = $state(new Set<string>());
  const toggleTable = (pid: string) => {
    const n = new Set(tableView);
    if (n.has(pid)) n.delete(pid);
    else n.add(pid);
    tableView = n;
  };
  const open = (e: MouseEvent, v: Panel["drill"]) => v && ws.open(v, target(e));
  const rangeLabel = $derived(inSentence(RANGES.find((r) => r.id === range)!.label));
  const resolution = $derived([...results.values()][0]?.table);
</script>

{#if !session.me?.isAdmin}
  <div class="empty"><h2>{t("Riservato agli amministratori")}</h2></div>
{:else}
  <div class="dv">
    <nav class="list" aria-label={t("Dashboard")}>
      <p class="cap">{t("Dashboard")}</p>
      {#each DASHBOARDS as d (d.id)}
        <a href="#/dashboard/{d.id}" class:on={d.id === dash.id} aria-current={d.id === dash.id ? "page" : undefined} onclick={(e) => (e.preventDefault(), ws.open({ kind: "dashboard", id: d.id }, target(e)))}>
          <Icon name={d.icon} size={16} />{d.title}
        </a>
      {/each}
      <p class="cap">{t("Console")}</p>
      <a href="#/admin/utenti" onclick={(e) => (e.preventDefault(), ws.open({ kind: "admin", section: "utenti" }, target(e)))}><Icon name="console" size={16} />{t("Amministrazione")}</a>
    </nav>

    <div class="main" bind:clientWidth={gridW}>
      <header class="bar">
        <div class="titles">
          <p class="eyebrow you">{t("Dashboard · {rangeLabel}", { rangeLabel })}</p>
          <h1>{dash.title}</h1>
          <p>{dash.description}</p>
        </div>
        <div class="controls">
          {#each dash.vars ?? [] as v (v.name)}
            <label class="ctl">{v.label}
              <select class="input" value={vars[v.name] ?? ""} onchange={(e) => (vars = { ...vars, [v.name]: (e.currentTarget as HTMLSelectElement).value })}>
                <option value="">{t("Tutti")}</option>
                {#each options(v.from) as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
              </select>
            </label>
          {/each}
          <select class="input" aria-label={t("Periodo")} bind:value={range}>{#each RANGES as r (r.id)}<option value={r.id}>{r.label}</option>{/each}</select>
          <select class="input" aria-label={t("Aggiornamento automatico")} bind:value={refresh}>{#each REFRESH as r (r.s)}<option value={r.s}>{r.label}</option>{/each}</select>
          <button class="icon-btn" title={t("Aggiorna ora")} aria-label={t("Aggiorna ora")} aria-busy={loading} onclick={load}><Icon name="refresh" size={16} /></button>
          <button class="icon-btn" title={cols < 12 ? t("Allarga la finestra per modificare il layout") : editing ? t("Fine modifica") : t("Sposta e ridimensiona i pannelli")} aria-label={t("Modifica il layout")} aria-pressed={editing} disabled={cols < 12} onclick={() => (editing = !editing)}><Icon name="edit" size={16} /></button>
        </div>
      </header>
      {#if EXPLAIN_DASHBOARD[dash.id]}<div class="explain-box"><Explain id={`dash-${dash.id}`} text={EXPLAIN_DASHBOARD[dash.id]!} /></div>{/if}
      <p class="meta" aria-live="polite">
        {#if error}<span class="err">{error}</span>
        {:else if updated}{t("Dati {rangeLabel}{x} · aggiornati alle {toLocaleTimeString} in {ms} ms", { rangeLabel, x: resolution ? `, risoluzione ${resolution === "1m" ? "1 minuto" : resolution === "1h" ? "1 ora" : "1 giorno"}` : "", toLocaleTimeString: updated.at.toLocaleTimeString(intlLocale), ms: nf.format(updated.ms) })}{/if}
        {#if editing}
          <span class="editing">{t("Trascina la maniglia per spostare e l'angolo per ridimensionare, oppure usa frecce e Maiusc+frecce sulla maniglia.")} <button class="lnk" onclick={resetLayout}>{t("Ripristina il layout")}</button></span>
        {/if}
      </p>

      <div class="grid" class:editing style="--row:{ROW}px;--gap:{GAP}px;--cols:{cols}">
        {#each dash.panels as p (p.id)}
          {@const pl = shown[p.id] ?? p.at}
          <section
            class="panel"
            style="grid-column:{pl.x + 1} / span {pl.w};grid-row:{pl.y + 1} / span {pl.h};--h:{pl.h}"
            aria-label={p.title}
          >
            <header class="ph">
              {#if editing}
                <button
                  class="grip"
                  aria-label={t("Sposta {title}: trascina, oppure frecce per spostare e Maiusc+frecce per ridimensionare", { title: p.title })}
                  title={t("Trascina per spostare")}
                  onpointerdown={(e) => startDrag(e, p.id, "move")}
                  onkeydown={(e) => onPanelKey(e, p.id)}><Icon name="more" size={14} /></button
                >
              {/if}
              <h2 title={p.help ?? ""}>{p.title}{#if p.help}<span class="help" aria-label={p.help}>?</span>{/if}</h2>
              <div class="pa">
                {#if p.kind === "timeseries" || p.kind === "bars"}
                  <button class="mini" aria-pressed={tableView.has(p.id)} onclick={() => toggleTable(p.id)} title={t("Mostra i valori in tabella")}>{tableView.has(p.id) ? t("Grafico") : t("Tabella")}</button>
                {/if}
                {#if p.drill}<button class="mini" onclick={(e) => open(e, p.drill)} title={t("Apri l'elenco")}>{t("Apri →")}</button>{/if}
              </div>
            </header>
            <div class="pb">
              {#if !updated && loading}
                <span class="skeleton" style="height:100%"></span>
              {:else if p.kind === "stat"}
                {@const s = statOf(p)}
                {@const lv = level(p, s.value)}
                <div class="stat {lv}">
                  <p class="big tabular">{fmt(s.value, p.unit)}</p>
                  {#if lv !== "ok"}<p class="state"><Icon name="alert" size={13} />{lv === "warn" ? t("Da controllare") : t("Critico")}</p>{/if}
                  {#if s.spark.length > 1}
                    <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d={spark(s.spark)} /></svg>
                  {/if}
                </div>
              {:else if p.kind === "timeseries"}
                {@const lines = linesOf(p)}
                {#if !lines.length}
                  <p class="none">{t("Nessun dato nel periodo.")}</p>
                {:else if tableView.has(p.id)}
                  <div class="tw">
                    <table class="adm-table">
                      <thead><tr><th>{t("Serie")}</th><th class="num">{t("Ultimo")}</th><th class="num">{t("Media")}</th><th class="num">{t("Massimo")}</th></tr></thead>
                      <tbody>
                        {#each lines as l (l.key)}
                          {@const vals = l.points.map((x) => x[1]).filter((v): v is number => v !== null)}
                          <tr><td><span class="sw" style="background:{l.color}"></span>{l.label}</td><td class="num">{fmt(vals.at(-1), p.unit)}</td><td class="num">{fmt(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, p.unit)}</td><td class="num">{fmt(vals.length ? Math.max(...vals) : null, p.unit)}</td></tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else}
                  <TimeSeries {lines} unit={p.unit} from={window_.from} to={window_.to} />
                {/if}
              {:else if p.kind === "bars"}
                {@const items = barsOf(p)}
                {#if tableView.has(p.id)}
                  <div class="tw">
                    <table class="adm-table">
                      <thead><tr><th>{t("Voce")}</th><th class="num">{t("Valore")}</th></tr></thead>
                      <tbody>{#each [...items].sort((a, b) => b.value - a.value) as it (it.label)}<tr><td>{it.label}</td><td class="num">{fmt(it.value, p.unit)}</td></tr>{/each}</tbody>
                    </table>
                  </div>
                {:else}
                  <Bars {items} unit={p.unit} />
                {/if}
              {:else if p.kind === "table"}
                {@const rows = rowsOf(p)}
                <div class="tw">
                  <table class="adm-table">
                    <thead><tr>{#each p.columns as c (c.key)}<th class:num={c.num}>{c.label}</th>{/each}</tr></thead>
                    <tbody>
                      {#each rows as r, i (i)}
                        {@const to = p.rowDrill?.(r) ?? null}
                        <tr class:click={!!to} onclick={(e) => to && ws.open(to, target(e))}>
                          {#each p.columns as c (c.key)}<td class:num={c.num} class:wrap={c.unit === "text"}>{cell(r[c.key], c.unit)}</td>{/each}
                        </tr>
                      {:else}
                        <tr><td colspan={p.columns.length} class="dim">{t("Nessuna riga.")}</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
            {#if editing}<span class="resize" onpointerdown={(e) => startDrag(e, p.id, "size")} aria-hidden="true"></span>{/if}
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .dv {
    min-height: 0;
    display: grid;
    grid-template-columns: 13.5rem minmax(0, 1fr);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 1rem 0.6rem;
    border-right: 1px solid var(--line);
    overflow-y: auto;
  }
  .cap {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.8rem 0.6rem 0.35rem;
  }
  .cap:first-child {
    padding-top: 0;
  }
  .list a {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.42rem 0.6rem;
    border-radius: var(--r-control);
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--fs-sm);
  }
  .list a:hover {
    background: var(--ink-1);
    color: var(--text-main);
  }
  .list a.on {
    background: var(--ink-2);
    color: var(--text-main);
    font-weight: 600;
  }
  .main {
    overflow-y: auto;
    min-height: 0;
    padding: 1.25rem 1.5rem 4rem;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: end;
    gap: 0.75rem;
  }
  h1 {
    font-size: var(--fs-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .titles p:not(.eyebrow) {
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }
  .controls .input {
    width: auto;
  }
  .ctl {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .explain-box {
    margin-top: 0.75rem;
  }
  .meta {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    margin: 0.5rem 0 0.9rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
  }
  .err {
    color: var(--alert-ink);
  }
  .editing {
    color: var(--you-ink);
  }
  .lnk {
    border: 0;
    background: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    grid-auto-rows: var(--row);
    gap: var(--gap);
  }
  .panel {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--ink-1);
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    padding: 0.6rem 0.75rem 0.65rem;
    transition: box-shadow var(--transition-fast);
  }
  .grid.editing .panel {
    border-style: dashed;
    border-color: var(--line-strong);
  }
  .ph {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
    min-width: 0;
  }
  .grip {
    border: 0;
    background: var(--ink-2);
    color: var(--text-muted);
    border-radius: 5px;
    width: 22px;
    height: 20px;
    display: grid;
    place-items: center;
    cursor: grab;
    touch-action: none;
    flex-shrink: 0;
  }
  .grip:focus-visible {
    outline: 2px solid var(--border-focus);
  }
  .ph h2 {
    flex: 1;
  }
  .ph h2 {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .help {
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
    margin-left: 0.35rem;
    border-radius: 50%;
    background: var(--ink-2);
    font-size: 10px;
    color: var(--text-dim);
    cursor: help;
  }
  .pa {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  .mini {
    border: 0;
    background: none;
    color: var(--text-dim);
    font-size: var(--fs-xs);
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 5px;
  }
  .mini:hover,
  .mini[aria-pressed="true"] {
    background: var(--ink-2);
    color: var(--text-main);
  }
  .pb {
    min-height: 0;
    min-width: 0;
    position: relative;
  }
  /* charts measure the panel body: out of the flow, so their width cannot widen the body */
  .pb > :global(.ts) {
    position: absolute;
    inset: 0;
  }
  .stat {
    height: 100%;
    display: grid;
    grid-template-rows: auto auto 1fr;
    align-content: start;
  }
  .big {
    font-size: var(--fs-2xl);
    font-weight: 650;
    line-height: 1.1;
    color: var(--text-main);
  }
  .state {
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .stat.warn .state {
    color: var(--you-ink);
  }
  .stat.alert .state {
    color: var(--alert-ink);
  }
  .stat.warn {
    box-shadow: inset 3px 0 0 var(--you);
    padding-left: 0.6rem;
  }
  .stat.alert {
    box-shadow: inset 3px 0 0 var(--alert);
    padding-left: 0.6rem;
  }
  .spark {
    width: 100%;
    height: 100%;
    max-height: 2.4rem;
    align-self: end;
  }
  .spark path {
    fill: none;
    stroke: var(--series-1);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .none {
    color: var(--text-dim);
    font-size: var(--fs-sm);
    display: grid;
    place-items: center;
    height: 100%;
  }
  .tw {
    height: 100%;
    overflow: auto;
  }
  .tw .adm-table th {
    background: var(--ink-1);
  }
  .tw tr.click {
    cursor: pointer;
  }
  .tw td.wrap {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    white-space: normal;
    word-break: break-word;
    max-width: 50rem;
  }
  .sw {
    display: inline-block;
    width: 10px;
    height: 3px;
    border-radius: 2px;
    margin-right: 0.4rem;
    vertical-align: middle;
  }
  .resize {
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    touch-action: none;
    background: linear-gradient(135deg, transparent 50%, var(--text-dim) 50% 60%, transparent 60% 70%, var(--text-dim) 70% 80%, transparent 80%);
  }
  @media (max-width: 900px) {
    .dv {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .list {
      flex-direction: row;
      overflow-x: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
      padding: 0.5rem;
    }
    .cap {
      display: none;
    }
    .list a {
      white-space: nowrap;
    }
  }
</style>
