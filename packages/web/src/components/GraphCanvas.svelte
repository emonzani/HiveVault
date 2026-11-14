<script lang="ts">
  // Force-directed graph on a canvas (thousands of nodes stay smooth, unlike SVG). Wheel or
  // pinch zooms, drag pans, drag on a node moves it, keyboard: arrows pan, +/- zoom, 0 fits.
  // Colors come from the theme tokens and follow theme changes.
  //
  // Two uses: the local graph of a page (compact: a click opens the page) and the graph view:
  // a click selects, a double click or Enter
  // opens; with `clusters` the pages of each vault gather around their own center inside a
  // dashed area with the vault name; links curve with an arrow, dashed between vaults; the
  // links of the selected page show their relation; a minimap shows where the view is.
  import { onDestroy, onMount } from "svelte";
  import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
  import { folderOf } from "../lib/format.ts";
  import type { GraphEdge, GraphNode } from "../lib/types.ts";
  import { t } from "../lib/i18n.ts";

  let {
    nodes,
    edges,
    focusId = null,
    onopen,
    label = t("Grafo delle pagine"),
    compact = false,
    selectedId = null,
    onselect,
    clusters = false,
    vaultColor,
    vaultName,
    frozen = false,
    allLabels = false,
    minimap = false,
  }: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    focusId?: string | null;
    onopen: (id: string, e: MouseEvent | KeyboardEvent) => void;
    label?: string;
    compact?: boolean;
    /** Graph view: a click selects (onselect), a double click opens. */
    selectedId?: string | null;
    onselect?: (id: string | null) => void;
    clusters?: boolean;
    /** Index of the color of a vault in the series palette (--series-1..6). */
    vaultColor?: (vaultId: string) => number;
    vaultName?: (vaultId: string) => string;
    frozen?: boolean;
    allLabels?: boolean;
    minimap?: boolean;
  } = $props();

  type N = SimulationNodeDatum & GraphNode & { r: number; abbr: string };
  type L = SimulationLinkDatum<N> & { kind: string; cross: boolean };

  let canvas: HTMLCanvasElement | undefined = $state();
  let mini: HTMLCanvasElement | undefined = $state();
  let wrap: HTMLDivElement | undefined = $state();
  let sim: Simulation<N, L> | null = null;
  let simNodes: N[] = [];
  let simLinks: L[] = [];
  let view = { x: 0, y: 0, k: 1 };
  let hover: N | null = $state(null);
  let size = { w: 300, h: 200, dpr: 1 };
  let colors: Record<string, string> = {};
  let series: string[] = [];
  let solidInk = "#ffffff";
  let raf = 0;
  let neighbors = new Map<string, Set<string>>();
  let centers = new Map<string, { x: number; y: number }>();

  const TYPE_TOKEN: Record<string, string> = {
    entity: "--tax-entity",
    concept: "--tax-concept",
    decision: "--tax-decision",
    synthesis: "--tax-synthesis",
    source: "--tax-source",
    note: "--tax-note",
  };
  /** Relations worth a label; a plain wikilink needs none. */
  const RELATION: Record<string, string> = { embed: t("incorpora"), mention: t("menziona"), works_at: t("lavora presso"), decided_by: t("deciso da"), part_of: t("parte di") };
  const relationOf = (l: L) => (l.cross ? t("tra vault") : (RELATION[l.kind] ?? (l.kind && l.kind !== "wikilink" ? l.kind.replaceAll("_", " ") : "")));

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const get = (v: string) => cs.getPropertyValue(v).trim() || "#888";
    colors = Object.fromEntries(Object.entries(TYPE_TOKEN).map(([f, v]) => [f, get(v)]));
    colors.line = get("--line-strong");
    colors.grid = get("--line");
    colors.text = get("--text-main");
    colors.muted = get("--text-muted");
    colors.dim = get("--text-dim");
    colors.bg = get("--ink-0");
    colors.card = get("--ink-1");
    colors.focus = get("--you");
    series = [1, 2, 3, 4, 5, 6].map((i) => get(`--series-${i}`));
    solidInk = document.documentElement.getAttribute("data-theme") === "chiaro" ? "#ffffff" : get("--ink-0");
    draw();
  }
  const clusterColor = (vaultId: string) => series[(vaultColor?.(vaultId) ?? 0) % Math.max(1, series.length)] ?? colors.line!;

  /** "ETSI EN 319 522-1" -> "ETS"; "Alpi Sanità" -> "AS". */
  function abbr(title: string): string {
    const words = title.replace(/[«»"'()[\]]/g, " ").split(/[\s\-_/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
    return words
      .slice(0, 3)
      .map((w) => w[0]!)
      .join("")
      .toUpperCase();
  }

  function layoutCenters() {
    centers = new Map();
    const size = new Map<string, number>();
    for (const n of simNodes) size.set(n.vaultId, (size.get(n.vaultId) ?? 0) + 1);
    if (!clusters || size.size < 2) return;
    // each vault gets an arc of the circle as wide as its own area (radius ~ sqrt of its pages)
    const ids = [...size.keys()].sort((a, b) => size.get(b)! - size.get(a)!);
    const rad = ids.map((id) => 50 + 26 * Math.sqrt(size.get(id)!));
    const total = rad.reduce((a, b) => a + 2 * b, 0) * 1.15;
    const R = Math.max(220, total / (2 * Math.PI));
    let angle = -Math.PI / 2;
    ids.forEach((id, i) => {
      const half = (rad[i]! * 1.15) / R;
      angle += half;
      centers.set(id, { x: Math.cos(angle) * R, y: Math.sin(angle) * R });
      angle += half;
    });
  }

  function build() {
    const old = new Map(simNodes.map((n) => [n.id, n]));
    const deg = new Map<string, number>();
    for (const e of edges) {
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    const max = compact ? 14 : 20;
    simNodes = nodes.map((n) => {
      const o = old.get(n.id);
      const d = n.degree ?? deg.get(n.id) ?? 0;
      const r = Math.min((compact ? 3.5 : 6) + Math.sqrt(d) * (compact ? 1.6 : 2.2), max);
      return Object.assign(o ?? { x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300 }, n, { r, abbr: abbr(n.title) }) as N;
    });
    const ids = new Set(simNodes.map((n) => n.id));
    simLinks = edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ source: e.from, target: e.to, kind: e.kind ?? "wikilink", cross: !!e.cross }));
    neighbors = new Map();
    for (const e of edges) {
      if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
      if (!neighbors.has(e.to)) neighbors.set(e.to, new Set());
      neighbors.get(e.from)!.add(e.to);
      neighbors.get(e.to)!.add(e.from);
    }
    layoutCenters();
    const pull = centers.size ? 0.22 : 0.04;
    sim?.stop();
    sim = forceSimulation<N, L>(simNodes)
      .force("link", forceLink<N, L>(simLinks).id((d) => d.id).distance((l) => (l.cross ? 220 : compact ? 38 : 70)).strength((l) => (l.cross ? (centers.size ? 0.005 : 0.05) : 0.4)))
      .force("charge", forceManyBody<N>().strength(compact ? -90 : -180).distanceMax(500))
      .force("collide", forceCollide<N>().radius((d) => d.r + (compact ? 3 : 10)))
      .force("center", forceCenter(0, 0))
      .force("x", forceX<N>((d) => centers.get(d.vaultId)?.x ?? 0).strength(pull))
      .force("y", forceY<N>((d) => centers.get(d.vaultId)?.y ?? 0).strength(pull))
      .alpha(old.size ? 0.5 : 1)
      .on("tick", schedule);
    if (focusId) {
      const f = simNodes.find((n) => n.id === focusId);
      if (f) (f.fx = 0), (f.fy = 0);
    }
    if (frozen) sim.stop();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()));
  }

  function resize() {
    if (!wrap || !canvas) return;
    const r = wrap.getBoundingClientRect();
    size = { w: Math.max(50, r.width), h: Math.max(50, r.height), dpr: devicePixelRatio || 1 };
    canvas.width = size.w * size.dpr;
    canvas.height = size.h * size.dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    draw();
  }

  // ---------------------------------------------------------------------------- geometry
  /** Convex hull (Andrew's monotone chain). */
  function hull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
    const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: typeof p = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper: typeof p = [];
    for (const q of [...p].reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
      upper.push(q);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
  }

  /** A rounded area around the pages of one vault: hull points pushed out, smoothed. */
  function clusterPath(ctx: CanvasRenderingContext2D, ns: N[]) {
    const cx = ns.reduce((a, n) => a + n.x!, 0) / ns.length;
    const cy = ns.reduce((a, n) => a + n.y!, 0) / ns.length;
    const pad = 34;
    const pts: { x: number; y: number }[] = [];
    for (const n of ns) for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push({ x: n.x! + Math.cos(a) * (n.r + pad), y: n.y! + Math.sin(a) * (n.r + pad) });
    }
    const h = hull(pts);
    ctx.beginPath();
    if (h.length < 3) {
      ctx.arc(cx, cy, pad * 2, 0, Math.PI * 2);
      return { minX: cx - pad * 2, minY: cy - pad * 2 };
    }
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const start = mid(h[h.length - 1]!, h[0]!);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < h.length; i++) {
      const m = mid(h[i]!, h[(i + 1) % h.length]!);
      ctx.quadraticCurveTo(h[i]!.x, h[i]!.y, m.x, m.y);
    }
    ctx.closePath();
    return { minX: Math.min(...h.map((q) => q.x)), minY: Math.min(...h.map((q) => q.y)) };
  }

  function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, fs: number, bg: string, fg: string, border?: string) {
    const padX = 5 / view.k;
    const w = ctx.measureText(text).width + padX * 2;
    const h = fs + 6 / view.k;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y, w, h, 3 / view.k);
    ctx.fillStyle = bg;
    ctx.fill();
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1 / view.k;
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.fillText(text, x, y + 3 / view.k);
  }

  // ---------------------------------------------------------------------------- drawing
  function draw() {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // dot grid of the study, in screen space
    if (!compact) {
      ctx.fillStyle = colors.grid!;
      const step = 22;
      const ox = (((view.x % step) + step) % step) + w / 2 - Math.floor(w / 2 / step) * step;
      const oy = (((view.y % step) + step) % step) + h / 2 - Math.floor(h / 2 / step) * step;
      for (let x = ox % step; x < w; x += step) for (let y = oy % step; y < h; y += step) ctx.fillRect(x, y, 1.2, 1.2);
    }

    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);
    const sel = selectedId ? (simNodes.find((n) => n.id === selectedId) ?? null) : null;
    const hi = hover ?? sel ?? (focusId ? (simNodes.find((n) => n.id === focusId) ?? null) : null);
    const near = hi ? (neighbors.get(hi.id) ?? new Set<string>()) : null;

    // vault areas
    if (clusters && centers.size) {
      const byVault = new Map<string, N[]>();
      for (const n of simNodes) byVault.set(n.vaultId, [...(byVault.get(n.vaultId) ?? []), n]);
      ctx.font = `650 ${10.5 / view.k}px "Plus Jakarta Sans Variable", system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      for (const [vid, ns] of byVault) {
        const c = clusterColor(vid);
        const box = clusterPath(ctx, ns);
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = c;
        ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.2 / view.k;
        ctx.setLineDash([5 / view.k, 4 / view.k]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = c;
        ctx.fillText(`✦ ${vaultName?.(vid) ?? "vault"} · ${ns.length}`, box.minX + 12, box.minY + 4);
      }
    }

    // links: a light curve, an arrow at the target, dashed between vaults
    for (const l of simLinks) {
      const s = l.source as N;
      const t = l.target as N;
      const lit = !!hi && (s.id === hi.id || t.id === hi.id);
      const dx = t.x! - s.x!;
      const dy = t.y! - s.y!;
      const len = Math.hypot(dx, dy) || 1;
      const bend = compact ? 0 : 0.12;
      const mx = (s.x! + t.x!) / 2 - dy * bend;
      const my = (s.y! + t.y!) / 2 + dx * bend;
      ctx.strokeStyle = lit ? colors.focus! : l.cross ? colors.dim! : clusters ? clusterColor(s.vaultId) : colors.line!;
      ctx.globalAlpha = hi && !lit ? 0.18 : lit ? 0.95 : clusters && !l.cross ? 0.55 : 0.75;
      ctx.lineWidth = (lit ? 1.6 : 1) / view.k;
      if (l.cross) ctx.setLineDash([4 / view.k, 3 / view.k]);
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.quadraticCurveTo(mx, my, t.x!, t.y!);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!compact && len > t.r * 2) {
        // arrow head on the border of the target, along the tangent at the end of the curve
        const tx = t.x! - mx;
        const ty = t.y! - my;
        const tl = Math.hypot(tx, ty) || 1;
        const ux = tx / tl;
        const uy = ty / tl;
        const ax = t.x! - ux * (t.r + 2);
        const ay = t.y! - uy * (t.r + 2);
        const a = 6 / view.k;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - ux * a - uy * a * 0.55, ay - uy * a + ux * a * 0.55);
        ctx.lineTo(ax - ux * a + uy * a * 0.55, ay - uy * a - ux * a * 0.55);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // relation labels of the highlighted page
    if (!compact && hi) {
      const fs = 9.5 / view.k;
      ctx.font = `500 ${fs}px "Plus Jakarta Sans Variable", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const l of simLinks) {
        const s = l.source as N;
        const t = l.target as N;
        if (s.id !== hi.id && t.id !== hi.id) continue;
        const text = relationOf(l);
        if (!text) continue;
        const dx = t.x! - s.x!;
        const dy = t.y! - s.y!;
        const x = (s.x! + t.x!) / 2 - dy * 0.06;
        const y = (s.y! + t.y!) / 2 + dx * 0.06 - fs;
        pill(ctx, x, y, text, fs, colors.card!, colors.muted!, colors.grid);
      }
    }

    // pages: a tinted disc with the initials, solid for the most linked
    for (const n of simNodes) {
      const dimmed = hi && n.id !== hi.id && !near!.has(n.id);
      const c = colors[folderOf(n.type)] ?? colors.note!;
      const solid = !compact && (n.r >= 13 || n.id === selectedId);
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      if (n.id === selectedId) {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 7, 0, Math.PI * 2);
        ctx.fillStyle = colors.focus!;
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      if (compact) {
        ctx.fillStyle = c;
        ctx.fill();
      } else {
        ctx.fillStyle = solid ? c : colors.card!;
        ctx.fill();
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.6 / view.k;
        ctx.stroke();
        if (n.r >= 9) {
          ctx.font = `700 ${Math.max(7, n.r * 0.62)}px "JetBrains Mono Variable", ui-monospace, monospace`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = solid ? solidInk : c;
          ctx.fillText(n.abbr, n.x!, n.y! + 0.5);
        }
      }
      if (n.id === focusId) {
        ctx.strokeStyle = colors.focus!;
        ctx.lineWidth = 2 / view.k;
        ctx.stroke();
      }
    }

    // titles under the pages
    const fs = 11 / view.k;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of simNodes) {
      const show = allLabels || view.k > 1.6 || n.r > 12 || (hi && (n.id === hi.id || near!.has(n.id))) || simNodes.length <= 25;
      if (!show) continue;
      const dimmed = hi && n.id !== hi.id && !near!.has(n.id);
      ctx.globalAlpha = dimmed ? 0.35 : 1;
      const text = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title;
      const y = n.y! + n.r + 4 / view.k;
      if (compact) {
        ctx.font = `500 ${fs}px "Plus Jakarta Sans Variable", system-ui, sans-serif`;
        ctx.fillStyle = hi && n.id === hi.id ? colors.text! : colors.dim!;
        ctx.fillText(text, n.x!, y);
      } else if (n.id === selectedId) {
        ctx.font = `700 ${fs}px "Plus Jakarta Sans Variable", system-ui, sans-serif`;
        pill(ctx, n.x!, y + 2 / view.k, text, fs, colors.text!, colors.bg!);
        ctx.font = `700 ${9 / view.k}px "JetBrains Mono Variable", ui-monospace, monospace`;
        pill(ctx, n.x!, n.y! - n.r - 22 / view.k, "● SELEZIONATO", 9 / view.k, colors.focus!, solidInk);
      } else {
        ctx.font = `500 ${fs}px "Plus Jakarta Sans Variable", system-ui, sans-serif`;
        pill(ctx, n.x!, y, text, fs, colors.card!, hi && n.id === hi.id ? colors.text! : colors.muted!, colors.grid);
      }
    }
    ctx.globalAlpha = 1;
    drawMini();
  }

  // ---------------------------------------------------------------------------- minimap
  const MW = 168;
  const MH = 104;
  let miniBox = { minX: 0, minY: 0, s: 1 };
  function drawMini() {
    if (!minimap || !mini || !simNodes.length) return;
    const ctx = mini.getContext("2d");
    if (!ctx) return;
    const dpr = size.dpr;
    if (mini.width !== MW * dpr) (mini.width = MW * dpr), (mini.height = MH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MW, MH);
    const xs = simNodes.map((n) => n.x!);
    const ys = simNodes.map((n) => n.y!);
    const minX = Math.min(...xs) - 40;
    const minY = Math.min(...ys) - 40;
    const s = Math.min(MW / (Math.max(...xs) + 40 - minX), MH / (Math.max(...ys) + 40 - minY));
    miniBox = { minX, minY, s };
    for (const n of simNodes) {
      ctx.fillStyle = clusters ? clusterColor(n.vaultId) : (colors[folderOf(n.type)] ?? colors.note!);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc((n.x! - minX) * s, (n.y! - minY) * s, Math.max(1.5, n.r * s), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // the part of the graph on screen
    const tl = toWorld(0, 0);
    const br = toWorld(size.w, size.h);
    ctx.strokeStyle = colors.focus!;
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.2;
    ctx.strokeRect((tl.x - minX) * s, (tl.y - minY) * s, (br.x - tl.x) * s, (br.y - tl.y) * s);
    ctx.setLineDash([]);
  }
  function miniClick(e: MouseEvent) {
    const r = mini!.getBoundingClientRect();
    const wx = (e.clientX - r.left) / miniBox.s + miniBox.minX;
    const wy = (e.clientY - r.top) / miniBox.s + miniBox.minY;
    view.x = -wx * view.k;
    view.y = -wy * view.k;
    draw();
  }

  // ---------------------------------------------------------------------------- input
  function toWorld(cx: number, cy: number) {
    return { x: (cx - size.w / 2 - view.x) / view.k, y: (cy - size.h / 2 - view.y) / view.k };
  }
  function pick(cx: number, cy: number): N | null {
    const p = toWorld(cx, cy);
    let best: N | null = null;
    let bd = Infinity;
    for (const n of simNodes) {
      const d = (n.x! - p.x) ** 2 + (n.y! - p.y) ** 2;
      const r = n.r + 4 / view.k;
      if (d < r * r && d < bd) (best = n), (bd = d);
    }
    return best;
  }

  let drag: { mode: "pan" | "node"; node?: N; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  function local(e: PointerEvent | MouseEvent | WheelEvent) {
    const r = canvas!.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  }
  function down(e: PointerEvent) {
    const { cx, cy } = local(e);
    const n = pick(cx, cy);
    canvas!.setPointerCapture(e.pointerId);
    drag = { mode: n ? "node" : "pan", ...(n ? { node: n } : {}), sx: cx, sy: cy, vx: view.x, vy: view.y, moved: false };
    if (n) {
      n.fx = n.x;
      n.fy = n.y;
      if (!frozen) sim?.alphaTarget(0.25).restart();
    }
  }
  function move(e: PointerEvent) {
    const { cx, cy } = local(e);
    if (!drag) {
      const n = pick(cx, cy);
      if (n !== hover) {
        hover = n;
        canvas!.style.cursor = n ? "pointer" : "grab";
        draw();
      }
      return;
    }
    if (Math.abs(cx - drag.sx) + Math.abs(cy - drag.sy) > 3) drag.moved = true;
    if (drag.mode === "pan") {
      view.x = drag.vx + cx - drag.sx;
      view.y = drag.vy + cy - drag.sy;
      draw();
    } else if (drag.node) {
      const p = toWorld(cx, cy);
      drag.node.fx = p.x;
      drag.node.fy = p.y;
      if (frozen) (drag.node.x = p.x), (drag.node.y = p.y), draw();
    }
  }
  function up(e: PointerEvent) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.node) {
      sim?.alphaTarget(0);
      // a frozen graph keeps the page where it was dropped
      if (d.node.id !== focusId && !frozen) (d.node.fx = null), (d.node.fy = null);
      if (!d.moved) {
        if (onselect) onselect(d.node.id === selectedId ? null : d.node.id);
        else onopen(d.node.id, e);
      }
    } else if (!d.moved && onselect) onselect(null);
  }
  function dbl(e: MouseEvent) {
    const { cx, cy } = local(e);
    const n = pick(cx, cy);
    if (n && onselect) onopen(n.id, e);
    else if (!n) fit();
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    const { cx, cy } = local(e);
    const before = toWorld(cx, cy);
    const k = Math.min(6, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.k = k;
    view.x = cx - size.w / 2 - before.x * k;
    view.y = cy - size.h / 2 - before.y * k;
    draw();
  }
  /** Fits the whole graph, or the pages of one vault. */
  export function fit(vaultId?: string) {
    const ns = vaultId ? simNodes.filter((n) => n.vaultId === vaultId) : simNodes;
    if (!ns.length) return;
    const xs = ns.map((n) => n.x!);
    const ys = ns.map((n) => n.y!);
    const w = Math.max(...xs) - Math.min(...xs) + 120;
    // the vault labels sit above the areas and the overlays cover the edges: more room in height
    const h = Math.max(...ys) - Math.min(...ys) + (compact ? 120 : 220);
    view.k = Math.min(2, Math.max(0.15, Math.min(size.w / w, size.h / h)));
    view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k;
    view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k + (compact ? 0 : 16);
    draw();
  }
  function key(e: KeyboardEvent) {
    const step = 40;
    const target = hover ?? (selectedId ? simNodes.find((n) => n.id === selectedId) : null);
    if (e.key === "ArrowLeft") view.x += step;
    else if (e.key === "ArrowRight") view.x -= step;
    else if (e.key === "ArrowUp") view.y += step;
    else if (e.key === "ArrowDown") view.y -= step;
    else if (e.key === "+" || e.key === "=") view.k = Math.min(6, view.k * 1.2);
    else if (e.key === "-") view.k = Math.max(0.15, view.k / 1.2);
    else if (e.key === "0") return fit();
    else if (e.key === "Enter" && target) return onopen(target.id, e);
    else if (e.key === "Escape" && onselect && selectedId) return onselect(null);
    else return;
    e.preventDefault();
    draw();
  }

  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;
  let fitTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    ro = new ResizeObserver(resize);
    ro.observe(wrap!);
    mo = new MutationObserver(readColors);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    readColors();
    resize();
  });

  $effect(() => {
    void nodes;
    void edges;
    void focusId;
    void clusters;
    build();
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => fit(), compact ? 500 : 900);
  });
  // freeze: the simulation stops and every page stays where it is
  $effect(() => {
    if (frozen) sim?.stop();
    else sim?.alpha(0.3).restart();
  });
  $effect(() => {
    void selectedId;
    void allLabels;
    draw();
  });

  onDestroy(() => {
    sim?.stop();
    ro?.disconnect();
    mo?.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(fitTimer);
  });
</script>

<div class="graph" bind:this={wrap}>
  <canvas
    bind:this={canvas}
    tabindex="0"
    aria-roledescription={t("grafo interattivo")}
    aria-label={t("{label}: {n} pagine, {n2} collegamenti. Frecce per spostare, + e - per lo zoom, 0 per adattare{x}.", { label, n: nodes.length, n2: edges.length, x: onselect ? t(", Invio apre la pagina scelta") : '' })}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointerleave={() => !drag && hover && ((hover = null), draw())}
    onwheel={wheel}
    onkeydown={key}
    ondblclick={dbl}
  ></canvas>
  {#if minimap}
    <div class="mini">
      <p class="mini-title"><span>{t("Minimappa")}</span><span class="mono">{t("{n} pagine", { n: nodes.length })}</span></p>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (pointer shortcut; the keyboard pans the main canvas) -->
      <canvas bind:this={mini} style="width:{MW}px;height:{MH}px" aria-hidden="true" onclick={miniClick}></canvas>
    </div>
  {/if}
  {#if hover}
    <div class="tip" class:right={minimap}>{hover.title}</div>
  {/if}
</div>

<style>
  .graph {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  canvas {
    display: block;
    cursor: grab;
    touch-action: none;
  }
  canvas:focus-visible {
    outline-offset: -2px;
  }
  .tip {
    position: absolute;
    left: 0.6rem;
    bottom: 0.6rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--r-control);
    background: var(--ink-2);
    font-size: var(--fs-xs);
    pointer-events: none;
    max-width: calc(100% - 1.2rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tip.right {
    left: auto;
    right: 0.6rem;
    top: 0.6rem;
    bottom: auto;
  }
  .mini {
    position: absolute;
    left: 0.75rem;
    bottom: 0.75rem;
    padding: 0.45rem 0.5rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
    box-shadow: var(--shadow-subtle);
  }
  @media (max-width: 760px) {
    .mini {
      display: none;
    }
  }
  .mini-title {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.3rem;
    font-size: 0.6875rem;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .mini-title .mono {
    letter-spacing: 0;
    text-transform: none;
    color: var(--busy-ink);
  }
  .mini canvas {
    cursor: pointer;
    border-radius: var(--r-control);
    background: var(--ink-0);
  }
</style>
