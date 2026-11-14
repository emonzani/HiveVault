// Metrics of the dashboards (plan §8.4): query and result types, time ranges, value formatting.
// No browser APIs: the phase 7 benchmark imports the dashboard definitions from Node.
import { intlLocale, t } from "./i18n.ts";

export type Agg = "rate" | "sum" | "avg" | "max" | "min" | "last" | "count" | "p50" | "p95" | "p99";
export type Unit = "count" | "perMin" | "ms" | "seconds" | "bytes" | "bytesPerSec" | "percent" | "ratio" | "tokens" | "x" | "celsius" | "watt";

export interface MetricQ {
  name: string;
  agg: Agg;
  match?: Record<string, string>;
  groupBy?: string[];
  /** Series label: a template with {label} placeholders, or a fixed text. */
  label?: string;
}
export interface Series {
  labels: Record<string, string>;
  points: [number, number | null][];
}
export interface QueryResult {
  id: string;
  name: string;
  step: number;
  table: "1m" | "1h" | "1d";
  series: Series[];
}

export const RANGES = [
  { id: "1h", label: t("Ultima ora"), ms: 3600_000 },
  { id: "6h", label: t("Ultime 6 ore"), ms: 6 * 3600_000 },
  { id: "24h", label: t("Ultime 24 ore"), ms: 86_400_000 },
  { id: "7d", label: t("Ultimi 7 giorni"), ms: 7 * 86_400_000 },
  { id: "30d", label: t("Ultimi 30 giorni"), ms: 30 * 86_400_000 },
  { id: "90d", label: t("Ultimi 90 giorni"), ms: 90 * 86_400_000 },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];
export const REFRESH = [
  { s: 0, label: t("Manuale") },
  { s: 30, label: t("Ogni 30 s") },
  { s: 60, label: t("Ogni minuto") },
  { s: 300, label: t("Ogni 5 minuti") },
] as const;

/** Label of a series: the template with its {label} values, or the label values joined. */
export function seriesLabel(q: MetricQ, s: Series, fallback: string): string {
  if (q.label) return q.label.replace(/\{(\w+)\}/g, (_, k: string) => s.labels[k] ?? "—");
  const v = Object.values(s.labels);
  return v.length ? v.join(" · ") : fallback;
}

const it = (max: number) => new Intl.NumberFormat(intlLocale, { maximumFractionDigits: max });
const n0 = it(0);
const n1 = it(1);
const n2 = it(2);
const short = (v: number) => (Math.abs(v) >= 1e6 ? t("{format} Mln", { format: n1.format(v / 1e6) }) : Math.abs(v) >= 1e4 ? `${n1.format(v / 1e3)}k` : Math.abs(v) >= 100 ? n0.format(v) : Math.abs(v) >= 10 ? n1.format(v) : n2.format(v));

export function fmt(v: number | null | undefined, unit: Unit = "count"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "ms":
      return v >= 10_000 ? `${n1.format(v / 1000)} s` : `${n0.format(v)} ms`;
    case "seconds":
      return v >= 7200 ? `${n1.format(v / 3600)} h` : v >= 120 ? `${n0.format(v / 60)} min` : `${n0.format(v)} s`;
    case "bytes":
    case "bytesPerSec": {
      const u = ["B", "KB", "MB", "GB", "TB"];
      let x = v;
      let i = 0;
      while (Math.abs(x) >= 1024 && i < u.length - 1) {
        x /= 1024;
        i++;
      }
      return `${i ? n1.format(x) : n0.format(x)} ${u[i]}${unit === "bytesPerSec" ? "/s" : ""}`;
    }
    case "percent":
      return `${n1.format(v)}%`;
    case "ratio":
      return `${n1.format(v * 100)}%`;
    case "perMin":
      return `${short(v)}/min`;
    case "tokens":
      return `${short(v)} token`;
    case "x":
      return n2.format(v);
    case "celsius":
      return `${n0.format(v)} °C`;
    case "watt":
      return `${n0.format(v)} W`;
    default:
      return short(v);
  }
}

/** Axis ticks: 0 and "nice" steps up to at least max. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let t = 0; t <= max + step * 0.001; t += step) out.push(t);
  if (out.at(-1)! < max) out.push(out.at(-1)! + step);
  return out;
}

/** Time label for an axis: hours within a day and a half, dates beyond. */
export function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs <= 36 * 3600_000) return d.toLocaleTimeString(intlLocale, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(intlLocale, { day: "numeric", month: "short" });
}
export const fullTime = (t: number) => new Date(t).toLocaleString(intlLocale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const SERIES_VARS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6"];
/** At most 6 series keep a color (fixed order, by entity); the rest fold into "Altri". */
export const MAX_SERIES = 6;
