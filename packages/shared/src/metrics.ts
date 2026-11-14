/**
 * In-process metrics registry (plan §8.4). Any package records with three kinds:
 *
 *   counter    something happened n times                metrics.inc("http_requests", { route, status })
 *   gauge      a value now (last sample of the minute)    metrics.set("tasks_queued", 12, { name })
 *   histogram  durations or sizes, in fixed buckets       metrics.observe("search_ms", 42, { branch })
 *
 * Every minute the metrics package drains the registry (`drain`) into Postgres; `/metrics`
 * reads the cumulative values (`prometheus`). Label values must have few distinct values
 * (route templates, status classes, vault ids): never user input.
 */

export type Labels = Record<string, string>;

/** Default buckets for durations in milliseconds. */
export const MS_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 120_000];

interface Agg {
  sum: number;
  count: number;
  min: number;
  max: number;
  last: number;
}

export interface MetricSample {
  name: string;
  labels: Labels;
  kind: "counter" | "gauge" | "histogram";
  sum: number;
  count: number;
  min: number;
  max: number;
  last: number;
  /** Histograms: count per bucket upper bound ("+Inf" for the rest). */
  buckets?: Record<string, number>;
}

const MAX_SERIES = 5000;

function keyOf(name: string, labels: Labels): string {
  const ks = Object.keys(labels).sort();
  return ks.length ? `${name}{${ks.map((k) => `${k}=${labels[k]}`).join(",")}}` : name;
}

class Series {
  window: Agg = { sum: 0, count: 0, min: Infinity, max: -Infinity, last: 0 };
  total: Agg = { sum: 0, count: 0, min: Infinity, max: -Infinity, last: 0 };
  wBuckets: number[] | null;
  tBuckets: number[] | null;
  constructor(
    readonly name: string,
    readonly labels: Labels,
    readonly kind: MetricSample["kind"],
    readonly bounds: number[] | null,
  ) {
    this.wBuckets = bounds ? new Array(bounds.length + 1).fill(0) : null;
    this.tBuckets = bounds ? new Array(bounds.length + 1).fill(0) : null;
  }
  add(v: number) {
    for (const a of [this.window, this.total]) {
      a.sum += v;
      a.count++;
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      a.last = v;
    }
    if (this.bounds) {
      let i = this.bounds.findIndex((b) => v <= b);
      if (i < 0) i = this.bounds.length;
      this.wBuckets![i]!++;
      this.tBuckets![i]!++;
    }
  }
}

export class MetricsRegistry {
  private series = new Map<string, Series>();
  private dropped = 0;

  private get(name: string, labels: Labels, kind: MetricSample["kind"], bounds: number[] | null): Series | null {
    const k = keyOf(name, labels);
    let s = this.series.get(k);
    if (!s) {
      if (this.series.size >= MAX_SERIES) {
        this.dropped++;
        return null;
      }
      s = new Series(name, { ...labels }, kind, bounds);
      this.series.set(k, s);
    }
    return s;
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    this.get(name, labels, "counter", null)?.add(by);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    const s = this.get(name, labels, "gauge", null);
    if (!s) return;
    // a gauge keeps only the last value (and min/max inside the minute)
    s.window = { sum: value, count: 1, min: Math.min(s.window.count ? s.window.min : value, value), max: Math.max(s.window.count ? s.window.max : value, value), last: value };
    s.total = { sum: value, count: 1, min: value, max: value, last: value };
  }

  observe(name: string, value: number, labels: Labels = {}, bounds: number[] = MS_BUCKETS): void {
    if (!Number.isFinite(value)) return;
    this.get(name, labels, "histogram", bounds)?.add(value);
  }

  /** Measures an async function as a histogram in milliseconds. */
  async time<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - t0, labels);
    }
  }

  /** The values of the last window, and a new empty window. Gauges keep their last value. */
  drain(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const s of this.series.values()) {
      const w = s.window;
      if (w.count === 0) continue;
      const sample: MetricSample = { name: s.name, labels: s.labels, kind: s.kind, sum: w.sum, count: w.count, min: w.min, max: w.max, last: w.last };
      if (s.bounds) {
        sample.buckets = Object.fromEntries(s.wBuckets!.map((n, i) => [i < s.bounds!.length ? String(s.bounds![i]) : "+Inf", n]));
        s.wBuckets!.fill(0);
      }
      out.push(sample);
      s.window = s.kind === "gauge" ? { ...w } : { sum: 0, count: 0, min: Infinity, max: -Infinity, last: w.last };
    }
    return out;
  }

  /** Prometheus text format: counters and histograms are cumulative since the process start. */
  prometheus(prefix = "cb_"): string {
    const byName = new Map<string, Series[]>();
    for (const s of this.series.values()) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const lbl = (l: Labels, extra?: Labels) => {
      const all = { ...l, ...extra };
      const ks = Object.keys(all);
      return ks.length ? `{${ks.map((k) => `${k}="${esc(all[k]!)}"`).join(",")}}` : "";
    };
    const lines: string[] = [];
    for (const [name, list] of [...byName.entries()].sort()) {
      const n = prefix + name.replace(/[^a-zA-Z0-9_]/g, "_");
      const kind = list[0]!.kind;
      lines.push(`# TYPE ${kind === "counter" ? `${n}_total` : n} ${kind}`);
      for (const s of list) {
        if (kind === "counter") lines.push(`${n}_total${lbl(s.labels)} ${s.total.sum}`);
        else if (kind === "gauge") lines.push(`${n}${lbl(s.labels)} ${s.total.last}`);
        else {
          let acc = 0;
          s.bounds!.forEach((b, i) => {
            acc += s.tBuckets![i]!;
            lines.push(`${n}_bucket${lbl(s.labels, { le: String(b) })} ${acc}`);
          });
          lines.push(`${n}_bucket${lbl(s.labels, { le: "+Inf" })} ${s.total.count}`);
          lines.push(`${n}_sum${lbl(s.labels)} ${s.total.sum}`);
          lines.push(`${n}_count${lbl(s.labels)} ${s.total.count}`);
        }
      }
    }
    if (this.dropped) lines.push(`# ${this.dropped} samples dropped: more than ${MAX_SERIES} series`);
    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.series.clear();
    this.dropped = 0;
  }
}

/** The registry of the process. */
export const metrics = new MetricsRegistry();
