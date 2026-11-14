/**
 * Metrics in Postgres (plan §8.4): one row per series and minute in `metrics_1m` (daily
 * partitions, 14 days), rolled up into `metrics_1h` (400 days) and `metrics_1d` (kept).
 * Queries pick the table by range and downsample to a few hundred points, so a panel over
 * 7 days of per-minute data reads at most a few thousand rows per series.
 */
import type { Sql } from "@cb/db";
import type { Labels, MetricSample } from "@cb/shared";

export type Agg = "rate" | "sum" | "avg" | "max" | "min" | "last" | "count" | "p50" | "p95" | "p99";

export interface MetricQuery {
  name: string;
  /** Only series whose labels include these values. A value "*" means "any". */
  match?: Labels;
  /** Labels kept in the result; the other ones are merged. Default: none (one series). */
  groupBy?: string[];
  agg: Agg;
  from: Date;
  to: Date;
  /** Points per series (default 300). */
  points?: number;
}

export interface MetricSeries {
  labels: Labels;
  points: [number, number][];
}

export interface MetricResult {
  name: string;
  agg: Agg;
  step: number;
  table: "1m" | "1h" | "1d";
  series: MetricSeries[];
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const partName = (d: Date) => `metrics_1m_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function keyOf(name: string, labels: Labels): string {
  const ks = Object.keys(labels).sort();
  return ks.length ? `${name}{${ks.map((k) => `${k}=${labels[k]}`).join(",")}}` : name;
}

/** Quantile from bucket counts (upper bounds), linear inside the bucket. */
export function quantile(buckets: Record<string, number>, q: number): number | null {
  const entries = Object.entries(buckets)
    .map(([k, v]) => [k === "+Inf" ? Infinity : Number(k), v] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return null;
  const rank = q * total;
  let acc = 0;
  let prevBound = 0;
  for (const [bound, n] of entries) {
    if (acc + n >= rank) {
      if (bound === Infinity) return prevBound;
      return prevBound + ((rank - acc) / Math.max(n, 1)) * (bound - prevBound);
    }
    acc += n;
    if (bound !== Infinity) prevBound = bound;
  }
  return prevBound;
}

export class MetricsStore {
  private ids = new Map<string, number>();
  private partitions = new Set<string>();

  constructor(
    private readonly sql: Sql,
    private readonly o: { minuteDays?: number; hourDays?: number } = {},
  ) {}

  private async seriesIds(samples: MetricSample[]): Promise<number[]> {
    const missing = samples.filter((s) => !this.ids.has(keyOf(s.name, s.labels)));
    if (missing.length) {
      const uniq = [...new Map(missing.map((s) => [keyOf(s.name, s.labels), s])).values()];
      const rows = await this.sql<{ id: number; key: string }[]>`
        insert into metric_series (name, labels, kind, key)
        select n, l::jsonb, k, key from unnest(${uniq.map((s) => s.name)}::text[], ${uniq.map((s) => JSON.stringify(s.labels))}::text[], ${uniq.map((s) => s.kind)}::text[], ${uniq.map((s) => keyOf(s.name, s.labels))}::text[]) as u(n, l, k, key)
        on conflict (key) do update set kind = excluded.kind
        returning id, key`;
      for (const r of rows) this.ids.set(r.key, r.id);
    }
    return samples.map((s) => this.ids.get(keyOf(s.name, s.labels))!);
  }

  /** Daily partitions from yesterday to 2 days ahead; older ones beyond the retention go. */
  async ensurePartitions(now = new Date()): Promise<{ created: string[]; dropped: string[] }> {
    const created: string[] = [];
    for (let i = -1; i <= 2; i++) {
      const d = new Date(dayStart(now).getTime() + i * DAY);
      const name = partName(d);
      if (this.partitions.has(name)) continue;
      const next = new Date(d.getTime() + DAY);
      const [exists] = await this.sql<{ n: number }[]>`select count(*)::int as n from pg_class where relname = ${name}`;
      if (!exists!.n) {
        await this.sql.unsafe(`create table if not exists ${name} partition of metrics_1m for values from ('${d.toISOString()}') to ('${next.toISOString()}')`);
        created.push(name);
      }
      this.partitions.add(name);
    }
    const keep = this.o.minuteDays ?? 14;
    const limit = partName(new Date(dayStart(now).getTime() - keep * DAY));
    const old = await this.sql<{ name: string }[]>`
      select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'metrics_1m'::regclass and c.relname < ${limit}`;
    for (const o of old) {
      await this.sql.unsafe(`drop table if exists ${o.name}`);
      this.partitions.delete(o.name);
    }
    await this.sql`delete from metrics_1h where bucket < now() - make_interval(days => ${this.o.hourDays ?? 400})`;
    return { created, dropped: old.map((o) => o.name) };
  }

  /** Adds the samples of one minute (several processes add to the same row). */
  async write(bucket: Date, samples: MetricSample[]): Promise<number> {
    if (!samples.length) return 0;
    const b = new Date(Math.floor(bucket.getTime() / 60_000) * 60_000);
    if (!this.partitions.has(partName(b))) await this.ensurePartitions(b);
    const ids = await this.seriesIds(samples);
    await this.sql`
      insert into metrics_1m (bucket, series_id, sum, count, min, max, last, buckets)
      select ${b}, sid, su, co, mi, ma, la, bu::jsonb from unnest(
        ${ids}::bigint[], ${samples.map((s) => s.sum)}::float8[], ${samples.map((s) => s.count)}::bigint[],
        ${samples.map((s) => s.min)}::float8[], ${samples.map((s) => s.max)}::float8[], ${samples.map((s) => s.last)}::float8[],
        ${samples.map((s) => (s.buckets ? JSON.stringify(s.buckets) : null))}::text[]) as u(sid, su, co, mi, ma, la, bu)
      on conflict (series_id, bucket) do update set
        sum = metrics_1m.sum + excluded.sum,
        count = metrics_1m.count + excluded.count,
        min = least(metrics_1m.min, excluded.min),
        max = greatest(metrics_1m.max, excluded.max),
        last = excluded.last,
        buckets = case when metrics_1m.buckets is null then excluded.buckets
          else (select jsonb_object_agg(k, coalesce((metrics_1m.buckets->>k)::float8, 0) + coalesce((excluded.buckets->>k)::float8, 0))
                from (select jsonb_object_keys(metrics_1m.buckets) union select jsonb_object_keys(excluded.buckets)) x(k)) end`;
    return samples.length;
  }

  /**
   * Rebuilds the hourly (from minutes) or daily (from hours) rows of a time range. Idempotent:
   * the collector runs it on the last two hours and the last two days.
   */
  async rollup(level: "1h" | "1d", from: Date, to: Date): Promise<number> {
    const [src, dst, unit] = level === "1h" ? ["metrics_1m", "metrics_1h", "hour"] : ["metrics_1h", "metrics_1d", "day"];
    const r = await this.sql.unsafe(
      `insert into ${dst} (bucket, series_id, sum, count, min, max, last, buckets)
       select t.b, t.series_id, t.sum, t.count, t.min, t.max, t.last,
              (select jsonb_object_agg(k, v) from (
                 select e.key as k, sum(e.value::float8) as v
                 from ${src} m2, jsonb_each_text(m2.buckets) e
                 where m2.series_id = t.series_id and m2.bucket >= t.b and m2.bucket < t.b + interval '1 ${unit}' and m2.buckets is not null
                 group by e.key) z)
       from (
         select date_trunc('${unit}', bucket, 'UTC') as b, series_id, sum(sum) as sum, sum(count)::bigint as count, min(min) as min, max(max) as max,
                (array_agg(last order by bucket desc))[1] as last
         from ${src} where bucket >= $1 and bucket < $2
         group by 1, 2) t
       on conflict (series_id, bucket) do update set sum = excluded.sum, count = excluded.count, min = excluded.min, max = excluded.max,
         last = excluded.last, buckets = excluded.buckets`,
      [from, to],
    );
    return r.count;
  }

  async catalog(): Promise<{ name: string; kind: string; labels: Record<string, string[]> }[]> {
    const rows = await this.sql<{ name: string; kind: string; labels: Labels }[]>`select name, kind, labels from metric_series order by name`;
    const out = new Map<string, { name: string; kind: string; labels: Record<string, Set<string>> }>();
    for (const r of rows) {
      const e = out.get(r.name) ?? { name: r.name, kind: r.kind, labels: {} };
      for (const [k, v] of Object.entries(r.labels)) (e.labels[k] ??= new Set()).add(v);
      out.set(r.name, e);
    }
    return [...out.values()].map((e) => ({ name: e.name, kind: e.kind, labels: Object.fromEntries(Object.entries(e.labels).map(([k, s]) => [k, [...s].sort()])) }));
  }

  async query(q: MetricQuery): Promise<MetricResult> {
    const from = q.from.getTime();
    const to = Math.max(q.to.getTime(), from + 60_000);
    const range = to - from;
    const table: MetricResult["table"] = range <= 36 * 3_600_000 ? "1m" : range <= 45 * DAY ? "1h" : "1d";
    const base = table === "1m" ? 60_000 : table === "1h" ? 3_600_000 : DAY;
    const step = Math.max(base, Math.ceil(range / (q.points ?? 300) / base) * base);

    const series = await this.sql<{ id: number; labels: Labels; kind: string }[]>`select id, labels, kind from metric_series where name = ${q.name}`;
    const matching = series.filter((s) => Object.entries(q.match ?? {}).every(([k, v]) => v === "*" || s.labels[k] === v));
    if (!matching.length) return { name: q.name, agg: q.agg, step, table, series: [] };
    const percentile = q.agg.startsWith("p");
    const ids = matching.map((s) => s.id);
    const tb = `(floor(extract(epoch from bucket) * 1000 / $3) * $3)::float8`;
    const rows = await this.sql.unsafe<{ sid: number; t: number; sum: number; count: number; min: number; max: number; last: number }[]>(
      `select series_id as sid, ${tb} as t, sum(sum)::float8 as sum, sum(count)::float8 as count, min(min)::float8 as min, max(max)::float8 as max,
              (array_agg(last order by bucket desc))[1]::float8 as last
       from metrics_${table} where series_id = any($1::bigint[]) and bucket >= $2 and bucket < $4
       group by 1, 2 order by 2`,
      [ids, new Date(from), step, new Date(to)],
    );
    // histograms: bucket counts summed per series and step
    const hist = new Map<string, Record<string, number>>();
    if (percentile) {
      const hb = await this.sql.unsafe<{ sid: number; t: number; k: string; v: number }[]>(
        `select series_id as sid, ${tb} as t, e.key as k, sum(e.value::float8)::float8 as v
         from metrics_${table} m, jsonb_each_text(m.buckets) e
         where series_id = any($1::bigint[]) and bucket >= $2 and bucket < $4 and buckets is not null
         group by 1, 2, 3`,
        [ids, new Date(from), step, new Date(to)],
      );
      for (const r of hb) {
        const k = `${r.sid}:${r.t}`;
        (hist.get(k) ?? hist.set(k, {}).get(k)!)[r.k] = r.v;
      }
    }

    // merge the series by the kept labels, then by time
    const group = (l: Labels) => Object.fromEntries((q.groupBy ?? []).map((k) => [k, l[k] ?? ""]));
    const byId = new Map(matching.map((s) => [s.id, s]));
    type Cell = { sum: number; count: number; min: number; max: number; last: number; buckets: Record<string, number> };
    const groups = new Map<string, { labels: Labels; cells: Map<number, Cell> }>();
    for (const r of rows) {
      const labels = group(byId.get(r.sid)!.labels);
      const gk = JSON.stringify(labels);
      const g = groups.get(gk) ?? { labels, cells: new Map<number, Cell>() };
      groups.set(gk, g);
      const c = g.cells.get(r.t) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity, last: 0, buckets: {} };
      c.sum += r.sum;
      c.count += r.count;
      c.min = Math.min(c.min, r.min);
      c.max = Math.max(c.max, r.max);
      // gauges of several series: the values add up (e.g. queued tasks of every task name)
      c.last += r.last;
      for (const [k, v] of Object.entries(hist.get(`${r.sid}:${r.t}`) ?? {})) c.buckets[k] = (c.buckets[k] ?? 0) + v;
      g.cells.set(r.t, c);
    }
    const kind = matching[0]!.kind;
    const minutes = step / 60_000;
    const value = (c: Cell): number | null => {
      switch (q.agg) {
        case "rate":
          return c.sum / minutes;
        case "sum":
          return c.sum;
        case "count":
          return c.count;
        case "avg":
          return c.count ? c.sum / c.count : null;
        case "max":
          return c.max;
        case "min":
          return c.min;
        case "last":
          return kind === "gauge" ? c.last : c.sum;
        default:
          return quantile(c.buckets, Number(q.agg.slice(1)) / 100);
      }
    };
    return {
      name: q.name,
      agg: q.agg,
      step,
      table,
      series: [...groups.values()]
        .map((g) => ({
          labels: g.labels,
          points: [...g.cells.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([t, c]) => [t, value(c)] as [number, number | null])
            .filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1])),
        }))
        .sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels))),
    };
  }
}
