// The 10 dashboards of the console (plan §8.4), as data: panels with their queries, units,
// thresholds, default grid places (12 columns) and drill-down targets. The engine is
// DashboardView; a viewer may move and resize panels, and the layout is kept per viewer.
import type { MetricQ, Unit } from "./metrics.ts";
import type { View } from "./views.ts";

import { t } from "./i18n.ts";
export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Base {
  id: string;
  title: string;
  /** Default place in the grid. */
  at: Place;
  /** Where "Apri" goes: a filtered list in the console. */
  drill?: View;
  help?: string;
}
export interface StatPanel extends Base {
  kind: "stat";
  unit: Unit;
  /** A metric (last value, with a sparkline), or a field of a stats table. */
  q?: MetricQ;
  /** Sum over the range instead of the last value (counters: "how many in the period"). */
  total?: boolean;
  stat?: { name: string; field: string };
  /** Bad when above (default) or below these values. */
  warn?: number;
  alert?: number;
  lowIsBad?: boolean;
}
export interface SeriesPanel extends Base {
  kind: "timeseries";
  unit: Unit;
  queries: MetricQ[];
}
export interface BarsPanel extends Base {
  kind: "bars";
  unit: Unit;
  q: MetricQ;
  /** How one series becomes one bar: the last value or the sum over the range. */
  reduce: "last" | "sum";
}
export interface TablePanel extends Base {
  kind: "table";
  stat: string;
  /** Sub-list of the stats answer (security: failures, blocked, …). */
  path?: string;
  columns: { key: string; label: string; unit?: Unit | "date" | "class" | "text"; num?: boolean }[];
  /** Row click: a view built from the row. */
  rowDrill?: (row: Record<string, unknown>) => View | null;
}
export type Panel = StatPanel | SeriesPanel | BarsPanel | TablePanel;

export interface Variable {
  name: string;
  label: string;
  /** Options from the vault list (value = vault id). */
  from: "spaces" | "vaults";
}
export interface Dashboard {
  id: string;
  title: string;
  description: string;
  icon: string;
  vars?: Variable[];
  panels: Panel[];
}

const at = (x: number, y: number, w: number, h: number): Place => ({ x, y, w, h });
const page = (r: Record<string, unknown>): View | null => (typeof r.id === "string" ? { kind: "page", id: r.id } : null);
const vaultBySlug = (r: Record<string, unknown>): View | null => (typeof r.slug === "string" ? { kind: "admin", section: "sorgenti", id: r.slug } : null);
const TASKS: View = { kind: "admin", section: "task" };
const SOURCES: View = { kind: "admin", section: "sorgenti" };
const MODELS: View = { kind: "admin", section: "modelli" };
const AUDIT: View = { kind: "admin", section: "audit" };

export const DASHBOARDS: Dashboard[] = [
  {
    id: "panoramica",
    title: t("Panoramica"),
    description: t("Lo stato del server in un colpo d'occhio: memoria, richieste, modelli, lavoro in coda."),
    icon: "gauge",
    panels: [
      { id: "pages", kind: "stat", title: t("Pagine"), unit: "count", q: { name: "pages_total", agg: "last" }, at: at(0, 0, 2, 2) },
      { id: "docs", kind: "stat", title: t("Documenti conservati"), unit: "bytes", q: { name: "sources_bytes", agg: "last" }, at: at(2, 0, 2, 2), drill: SOURCES },
      { id: "users", kind: "stat", title: t("Utenti attivi ora"), unit: "count", q: { name: "users_active", agg: "last" }, at: at(4, 0, 2, 2) },
      { id: "p95", kind: "stat", title: t("Ricerca p95"), unit: "ms", q: { name: "search_ms", agg: "p95", match: { branch: "total" } }, warn: 1500, alert: 4000, at: at(6, 0, 2, 2) },
      { id: "failed", kind: "stat", title: t("Task falliti (24 h)"), unit: "count", q: { name: "tasks", agg: "last", match: { status: "failed" } }, warn: 1, alert: 20, at: at(8, 0, 2, 2), drill: TASKS },
      { id: "curator", kind: "stat", title: t("Decisioni in attesa"), unit: "count", q: { name: "curator_open", agg: "last" }, warn: 20, alert: 100, at: at(10, 0, 2, 2), drill: { kind: "curator" } },
      { id: "http", kind: "timeseries", title: t("Richieste HTTP"), unit: "perMin", queries: [{ name: "http_requests", agg: "rate", groupBy: ["status"], label: "{status}" }], at: at(0, 2, 6, 4) },
      { id: "search", kind: "timeseries", title: t("Tempo di ricerca"), unit: "ms", queries: [{ name: "search_ms", agg: "p50", match: { branch: "total" }, label: t("mediana") }, { name: "search_ms", agg: "p95", match: { branch: "total" }, label: "p95" }], at: at(6, 2, 6, 4) },
      { id: "models", kind: "timeseries", title: t("Latenza dei modelli (p95)"), unit: "ms", queries: [{ name: "model_request_ms", agg: "p95", groupBy: ["kind"], label: "{kind}" }], at: at(0, 6, 6, 4), drill: MODELS },
      { id: "cpu", kind: "timeseries", title: t("CPU del server"), unit: "percent", queries: [{ name: "host_cpu_percent", agg: "avg", label: t("CPU") }], at: at(6, 6, 6, 4), drill: { kind: "dashboard", id: "host" } },
      { id: "status", kind: "bars", title: t("Sorgenti per stato"), unit: "count", q: { name: "sources", agg: "last", groupBy: ["status"], label: "{status}" }, reduce: "last", at: at(0, 10, 6, 4), drill: SOURCES },
      { id: "tasks", kind: "bars", title: t("Task attivi per tipo"), unit: "count", q: { name: "tasks", agg: "last", groupBy: ["name"], match: { status: "running" }, label: "{name}" }, reduce: "last", at: at(6, 10, 6, 4), drill: TASKS },
    ],
  },
  {
    id: "ingestion",
    title: t("Ingestion e import"),
    description: t("Documenti letti, velocità, errori dei parser, coda e livelli di copertura."),
    icon: "upload",
    panels: [
      { id: "backlog", kind: "stat", title: t("Documenti in coda"), unit: "count", stat: { name: "backlog", field: "queued" }, at: at(0, 0, 3, 2), drill: TASKS },
      { id: "rate", kind: "stat", title: t("Letti al minuto (ultima ora)"), unit: "perMin", stat: { name: "backlog", field: "perMinute" }, at: at(3, 0, 3, 2) },
      { id: "eta", kind: "stat", title: t("Minuti alla fine della coda"), unit: "count", stat: { name: "backlog", field: "etaMinutes" }, at: at(6, 0, 3, 2), help: t("Alla velocità dell'ultima ora.") },
      { id: "imports", kind: "stat", title: t("Import in corso"), unit: "count", q: { name: "imports_running", agg: "last" }, at: at(9, 0, 3, 2), drill: { kind: "admin", section: "import" } },
      { id: "parsed", kind: "timeseries", title: t("Documenti letti"), unit: "perMin", queries: [{ name: "ingest_parsed", agg: "rate", groupBy: ["outcome"], label: "{outcome}" }], at: at(0, 2, 6, 4) },
      { id: "bytes", kind: "timeseries", title: t("Byte letti per formato"), unit: "bytes", queries: [{ name: "ingest_bytes", agg: "sum", groupBy: ["format"], label: "{format}" }], at: at(6, 2, 6, 4) },
      { id: "phases", kind: "timeseries", title: t("Durata delle fasi (p95)"), unit: "ms", queries: [{ name: "task_phase_ms", agg: "p95", match: { task: "ingest" }, groupBy: ["phase"], label: "{phase}" }], at: at(0, 6, 6, 4) },
      { id: "queue", kind: "timeseries", title: t("Task di lettura"), unit: "count", queries: [{ name: "tasks", agg: "last", match: { name: "ingest" }, groupBy: ["status"], label: "{status}" }], at: at(6, 6, 6, 4), drill: TASKS },
      { id: "levels", kind: "bars", title: t("Copertura per livello"), unit: "count", q: { name: "sources_by_level", agg: "last", groupBy: ["level"], label: "{level}" }, reduce: "last", at: at(0, 10, 4, 4) },
      {
        id: "errors",
        kind: "table",
        title: t("Parser con errori"),
        stat: "ingest-errors",
        columns: [{ key: "parser", label: t("Parser") }, { key: "status", label: t("Stato") }, { key: "error", label: t("Errore") }, { key: "n", label: t("Documenti"), num: true }],
        at: at(4, 10, 8, 4),
        drill: { kind: "admin", section: "sorgenti" },
      },
      {
        id: "coverage",
        kind: "table",
        title: t("Copertura per vault"),
        stat: "coverage",
        columns: [{ key: "name", label: t("Vault") }, { key: "i0", label: "I0", num: true }, { key: "i1", label: "I1", num: true }, { key: "i2", label: "I2", num: true }, { key: "i3", label: "I3", num: true }, { key: "total", label: t("Totale"), num: true }],
        rowDrill: vaultBySlug,
        at: at(0, 14, 12, 5),
      },
      // M14, M19: the compilation queue and what the compiler does
      { id: "cwait", kind: "stat", title: t("Documenti da compilare"), unit: "count", stat: { name: "compile-queue", field: "waiting" }, at: at(0, 19, 3, 2), drill: TASKS },
      { id: "cmin", kind: "stat", title: t("Minuti alla compilazione"), unit: "count", stat: { name: "compile-queue", field: "waitMinutes" }, at: at(3, 19, 3, 2), help: t("Documenti in coda per il tempo medio delle ultime 50 compilazioni.") },
      { id: "cback", kind: "stat", title: t("Arretrato degli import"), unit: "count", stat: { name: "compile-queue", field: "backlog" }, at: at(6, 19, 3, 2), help: t("Documenti mai chiesti da compilare: li compila il modello quando è libero.") },
      { id: "chours", kind: "stat", title: t("Ore di modello per l'arretrato"), unit: "count", stat: { name: "compile-queue", field: "backlogHours" }, at: at(9, 19, 3, 2) },
      {
        id: "compiler",
        kind: "timeseries",
        title: t("Compilatore"),
        unit: "count",
        queries: [
          { name: "compile_pages", agg: "sum", label: t("pagine scritte") },
          { name: "compile_refused", agg: "sum", label: t("scritture rifiutate") },
          { name: "compile_no_tldr", agg: "sum", label: t("pagine senza sintesi") },
          { name: "compile_duplicates", agg: "sum", label: t("duplicati evitati") },
        ],
        at: at(0, 21, 6, 4),
      },
      { id: "dups", kind: "timeseries", title: t("Duplicati del ciclo notturno"), unit: "count", queries: [{ name: "dream_duplicates", agg: "sum", groupBy: ["outcome"], label: "{outcome}" }], at: at(6, 21, 6, 4) },
    ],
  },
  {
    id: "ricerca",
    title: t("Ricerca"),
    description: t("Volume, tempi per ramo (embedding, SQL, rerank), cache e degradi."),
    icon: "search",
    panels: [
      { id: "volume", kind: "stat", title: t("Ricerche nel periodo"), unit: "count", q: { name: "search_requests", agg: "sum" }, total: true, at: at(0, 0, 3, 2) },
      { id: "p50", kind: "stat", title: t("Mediana"), unit: "ms", q: { name: "search_ms", agg: "p50", match: { branch: "total" } }, warn: 800, alert: 2000, at: at(3, 0, 3, 2) },
      { id: "p95", kind: "stat", title: "p95", unit: "ms", q: { name: "search_ms", agg: "p95", match: { branch: "total" } }, warn: 1500, alert: 4000, at: at(6, 0, 3, 2) },
      { id: "degraded", kind: "stat", title: t("Ricerche degradate"), unit: "count", q: { name: "search_degraded", agg: "sum" }, total: true, warn: 1, alert: 50, at: at(9, 0, 3, 2), help: t("Un ramo (vettori o rerank) non ha risposto: risultati solo testuali.") },
      { id: "branches", kind: "timeseries", title: t("Tempo per ramo (p95)"), unit: "ms", queries: [{ name: "search_ms", agg: "p95", groupBy: ["branch"], label: "{branch}" }], at: at(0, 2, 8, 5) },
      { id: "cache", kind: "bars", title: t("Cache"), unit: "count", q: { name: "search_requests", agg: "sum", groupBy: ["cache"], label: "{cache}" }, reduce: "sum", at: at(8, 2, 4, 5) },
      { id: "requests", kind: "timeseries", title: t("Ricerche"), unit: "perMin", queries: [{ name: "search_requests", agg: "rate", groupBy: ["result"], label: "{result}" }], at: at(0, 7, 6, 4) },
      { id: "deg", kind: "timeseries", title: t("Degradi per ramo"), unit: "perMin", queries: [{ name: "search_degraded", agg: "rate", groupBy: ["branch"], label: "{branch}" }], at: at(6, 7, 6, 4), drill: MODELS },
      {
        id: "top",
        kind: "table",
        title: t("Pagine più lette (7 giorni)"),
        stat: "top-pages",
        columns: [{ key: "title", label: t("Pagina") }, { key: "vault", label: t("Vault") }, { key: "reads", label: t("Letture"), num: true }, { key: "readers", label: t("Lettori"), num: true }],
        rowDrill: page,
        at: at(0, 11, 12, 5),
      },
    ],
  },
  {
    id: "salute",
    title: t("Salute della memoria"),
    description: t("Link rotti, pagine orfane o vecchie, citazioni, contraddizioni."),
    icon: "check",
    panels: [
      { id: "broken", kind: "stat", title: t("Link non risolti"), unit: "count", q: { name: "memory_links_unresolved", agg: "last" }, warn: 50, alert: 500, at: at(0, 0, 2, 2) },
      { id: "orphans", kind: "stat", title: t("Pagine orfane"), unit: "count", q: { name: "memory_orphans", agg: "last" }, warn: 100, alert: 1000, at: at(2, 0, 2, 2) },
      { id: "cited", kind: "stat", title: t("Pagine con citazioni"), unit: "ratio", q: { name: "memory_pages_cited_ratio", agg: "last" }, warn: 0.6, alert: 0.3, lowIsBad: true, at: at(4, 0, 2, 2) },
      { id: "stale", kind: "stat", title: t("Ferme da 6 mesi"), unit: "count", q: { name: "memory_pages_stale", agg: "last" }, at: at(6, 0, 2, 2) },
      { id: "conflicts", kind: "stat", title: t("Affermazioni in conflitto"), unit: "count", q: { name: "memory_claims_in_conflict", agg: "last" }, warn: 10, alert: 100, at: at(8, 0, 2, 2), drill: { kind: "curator" } },
      { id: "density", kind: "stat", title: t("Link per pagina"), unit: "x", q: { name: "memory_graph_density", agg: "last" }, warn: 1, alert: 0.3, lowIsBad: true, at: at(10, 0, 2, 2), drill: { kind: "graph" } },
      { id: "trend", kind: "timeseries", title: t("Link rotti e orfane"), unit: "count", queries: [{ name: "memory_links_unresolved", agg: "last", label: t("link non risolti") }, { name: "memory_orphans", agg: "last", label: t("pagine orfane") }], at: at(0, 2, 12, 4) },
      { id: "brokenList", kind: "table", title: t("Link non risolti"), stat: "memory-lists", path: "broken", columns: [{ key: "title", label: t("Nella pagina") }, { key: "vault", label: t("Vault") }, { key: "target", label: t("Punta a") }], at: at(0, 6, 6, 5) },
      { id: "staleList", kind: "table", title: t("Pagine più vecchie"), stat: "memory-lists", path: "stale", columns: [{ key: "title", label: t("Pagina") }, { key: "updated", label: t("Aggiornata") }], rowDrill: page, at: at(6, 6, 6, 5) },
    ],
  },
  {
    id: "alveare",
    title: t("Alveare"),
    description: t("Promozioni dalle celle agli spazi, conflitti e decisioni dei curatori."),
    icon: "hive",
    vars: [{ name: "spazio", label: t("Spazio"), from: "spaces" }],
    panels: [
      { id: "promotions", kind: "timeseries", title: t("Pagine promosse"), unit: "perMin", queries: [{ name: "hive_promotions", agg: "rate", match: { space: "$spazio" }, groupBy: ["outcome"], label: "{outcome}" }], at: at(0, 0, 8, 4) },
      { id: "open", kind: "bars", title: t("Decisioni aperte per tipo"), unit: "count", q: { name: "curator_open", agg: "last", groupBy: ["kind"], label: "{kind}" }, reduce: "last", at: at(8, 0, 4, 4), drill: { kind: "curator" } },
      { id: "levels", kind: "timeseries", title: t("Sorgenti dello spazio per livello"), unit: "count", queries: [{ name: "sources_by_level", agg: "last", match: { scope: "$spazio" }, groupBy: ["level"], label: "{level}" }], at: at(0, 4, 12, 4) },
      {
        id: "spaces",
        kind: "table",
        title: t("Spazi"),
        stat: "hive",
        columns: [{ key: "name", label: t("Spazio") }, { key: "cells", label: t("Celle"), num: true }, { key: "pages", label: t("Pagine d'alveare"), num: true }, { key: "openConflicts", label: t("Conflitti aperti"), num: true }, { key: "resolved", label: t("Risolti"), num: true }, { key: "dismissed", label: t("Archiviati"), num: true }],
        at: at(0, 8, 7, 5),
        drill: { kind: "admin", section: "vault" },
      },
      { id: "cells", kind: "table", title: t("Celle più attive"), stat: "hive-cells", columns: [{ key: "name", label: t("Cella") }, { key: "claims", label: t("Affermazioni"), num: true }, { key: "pages", label: t("Pagine"), num: true }], at: at(7, 8, 5, 5) },
    ],
  },
  {
    id: "notte",
    title: t("Dream cycle"),
    description: t("Il ciclo notturno: durata dei passi, token usati, esito per vault."),
    icon: "moon",
    panels: [
      { id: "tokens", kind: "stat", title: t("Token nel periodo"), unit: "tokens", q: { name: "dream_tokens", agg: "sum" }, total: true, at: at(0, 0, 3, 2) },
      { id: "steps", kind: "timeseries", title: t("Durata dei passi (p95)"), unit: "ms", queries: [{ name: "dream_step_ms", agg: "p95", groupBy: ["step"], label: "{step}" }], at: at(3, 0, 9, 5) },
      { id: "tokensBy", kind: "bars", title: t("Token per passo"), unit: "tokens", q: { name: "dream_tokens", agg: "sum", groupBy: ["step"], label: "{step}" }, reduce: "sum", at: at(0, 2, 3, 6) },
      {
        id: "avg",
        kind: "table",
        title: t("Passi (ultime 2 settimane)"),
        stat: "dream-steps",
        columns: [{ key: "step", label: t("Passo") }, { key: "avgMs", label: t("Media"), unit: "ms", num: true }, { key: "maxMs", label: t("Massimo"), unit: "ms", num: true }, { key: "runs", label: t("Cicli"), num: true }],
        at: at(3, 5, 9, 4),
      },
      {
        id: "runs",
        kind: "table",
        title: t("Cicli per vault"),
        stat: "dream",
        columns: [{ key: "night", label: t("Notte") }, { key: "name", label: t("Vault") }, { key: "status", label: t("Esito") }, { key: "step", label: t("Passo") }, { key: "tokens", label: t("Token"), num: true }, { key: "ms", label: t("Durata"), unit: "ms", num: true }],
        at: at(0, 9, 12, 6),
        drill: { kind: "dream" },
      },
    ],
  },
  {
    id: "modelli",
    title: t("Modelli"),
    description: t("Latenza, velocità, code e token di ogni endpoint del dispatcher."),
    icon: "cpu",
    panels: [
      { id: "up", kind: "stat", title: t("Endpoint attivi"), unit: "count", q: { name: "model_endpoint_up", agg: "last" }, at: at(0, 0, 3, 2), drill: MODELS },
      { id: "local", kind: "stat", title: t("Processi locali in esecuzione"), unit: "count", q: { name: "model_local_running", agg: "last" }, at: at(3, 0, 3, 2), drill: MODELS },
      { id: "errors", kind: "stat", title: t("Errori nel periodo"), unit: "count", q: { name: "model_errors", agg: "sum" }, total: true, warn: 1, alert: 50, at: at(6, 0, 3, 2) },
      { id: "tokens", kind: "stat", title: t("Token nel periodo"), unit: "tokens", q: { name: "model_tokens", agg: "sum" }, total: true, at: at(9, 0, 3, 2) },
      { id: "latency", kind: "timeseries", title: t("Latenza per endpoint (p95)"), unit: "ms", queries: [{ name: "model_request_ms", agg: "p95", groupBy: ["endpoint"], label: "{endpoint}" }], at: at(0, 2, 6, 4) },
      { id: "speed", kind: "timeseries", title: t("Elementi al secondo"), unit: "x", queries: [{ name: "model_endpoint_items_per_sec", agg: "avg", groupBy: ["endpoint"], label: "{endpoint}" }], at: at(6, 2, 6, 4), help: t("Embedding e rerank: testi al secondo; chat: token al secondo.") },
      { id: "queue", kind: "timeseries", title: t("Richieste in coda"), unit: "count", queries: [{ name: "model_queue", agg: "max", groupBy: ["kind"], label: "{kind}" }], at: at(0, 6, 6, 4) },
      { id: "tokrate", kind: "timeseries", title: t("Token"), unit: "perMin", queries: [{ name: "model_tokens", agg: "rate", groupBy: ["type"], label: "{type}" }], at: at(6, 6, 6, 4) },
      { id: "items", kind: "bars", title: t("Elementi per endpoint"), unit: "count", q: { name: "model_items", agg: "sum", groupBy: ["endpoint"], label: "{endpoint}" }, reduce: "sum", at: at(0, 10, 6, 4) },
      { id: "errs", kind: "bars", title: t("Errori per endpoint"), unit: "count", q: { name: "model_errors", agg: "sum", groupBy: ["endpoint"], label: "{endpoint}" }, reduce: "sum", at: at(6, 10, 6, 4) },
    ],
  },
  {
    id: "database",
    title: t("Database"),
    description: t("Dimensione, cache, connessioni, partizioni dei vault e query lente."),
    icon: "database",
    panels: [
      { id: "size", kind: "stat", title: t("Dimensione"), unit: "bytes", q: { name: "db_size_bytes", agg: "last" }, at: at(0, 0, 3, 2), drill: { kind: "admin", section: "backup" } },
      { id: "hit", kind: "stat", title: t("Letture dalla cache"), unit: "ratio", q: { name: "db_cache_hit_ratio", agg: "avg" }, warn: 0.97, alert: 0.9, lowIsBad: true, at: at(3, 0, 3, 2) },
      { id: "conns", kind: "stat", title: t("Connessioni"), unit: "count", q: { name: "db_connections", agg: "last" }, warn: 150, alert: 190, at: at(6, 0, 3, 2) },
      { id: "deadlocks", kind: "stat", title: t("Deadlock (totale)"), unit: "count", q: { name: "db_deadlocks_total", agg: "last" }, warn: 1, alert: 10, at: at(9, 0, 3, 2) },
      { id: "tx", kind: "timeseries", title: t("Transazioni al minuto"), unit: "perMin", queries: [{ name: "db_commits_per_min", agg: "avg", label: t("commit") }, { name: "db_rollbacks_per_min", agg: "avg", label: t("rollback") }], at: at(0, 2, 6, 4) },
      { id: "state", kind: "timeseries", title: t("Connessioni per stato"), unit: "count", queries: [{ name: "db_connections", agg: "avg", groupBy: ["state"], label: "{state}" }], at: at(6, 2, 6, 4) },
      { id: "parts", kind: "bars", title: t("Partizioni più grandi"), unit: "bytes", q: { name: "db_partition_bytes", agg: "last", groupBy: ["vault"], label: "{vault}" }, reduce: "last", at: at(0, 6, 5, 6) },
      {
        id: "partitions",
        kind: "table",
        title: t("Partizioni dei vault"),
        stat: "partitions",
        columns: [{ key: "name", label: t("Vault") }, { key: "bytes", label: t("Spazio"), unit: "bytes", num: true }, { key: "vectorIndexBytes", label: t("Indice HNSW"), unit: "bytes", num: true }, { key: "live", label: t("Righe"), num: true }, { key: "dead", label: t("Righe morte"), num: true }, { key: "lastVacuum", label: t("Ultimo vacuum"), unit: "date" }],
        rowDrill: vaultBySlug,
        at: at(5, 6, 7, 6),
      },
      {
        id: "slow",
        kind: "table",
        title: t("Query che pesano di più (pg_stat_statements)"),
        stat: "slow-queries",
        columns: [{ key: "kind", label: t("Tipo") }, { key: "query", label: t("Query"), unit: "text" }, { key: "calls", label: t("Chiamate"), num: true }, { key: "meanMs", label: t("Media"), unit: "ms", num: true }, { key: "totalS", label: t("Totale (s)"), num: true }],
        at: at(0, 12, 12, 6),
        help: t("Ordinate per tempo totale (media × chiamate). Backup e manutenzione sono in fondo: sono rari e lenti per natura (pg_backup_start aspetta un checkpoint). Vuota se pg_stat_statements non è attivo."),
      },
    ],
  },
  {
    id: "sicurezza",
    title: t("Accessi e sicurezza"),
    description: t("Accessi, sessioni, letture per canale, connessioni bloccate."),
    icon: "shield",
    panels: [
      { id: "users", kind: "stat", title: t("Utenti attivi ora"), unit: "count", q: { name: "users_active", agg: "last" }, at: at(0, 0, 3, 2), drill: { kind: "admin", section: "utenti" } },
      { id: "sessions", kind: "stat", title: t("Sessioni aperte"), unit: "count", q: { name: "sessions_open", agg: "last" }, at: at(3, 0, 3, 2) },
      { id: "api", kind: "stat", title: t("Account API attivi (1 h)"), unit: "count", q: { name: "api_accounts_active", agg: "last" }, at: at(6, 0, 3, 2), drill: { kind: "admin", section: "api" } },
      { id: "egress", kind: "stat", title: t("Connessioni bloccate"), unit: "count", q: { name: "egress_blocked", agg: "sum" }, total: true, warn: 1, alert: 20, at: at(9, 0, 3, 2), drill: AUDIT, help: t("Tentativi di uscire verso host non ammessi.") },
      { id: "outcome", kind: "timeseries", title: t("Eventi di audit per esito"), unit: "perMin", queries: [{ name: "audit_events", agg: "rate", groupBy: ["outcome"], label: "{outcome}" }], at: at(0, 2, 6, 4), drill: AUDIT },
      { id: "reads", kind: "timeseries", title: t("Letture per canale"), unit: "perMin", queries: [{ name: "reads", agg: "rate", groupBy: ["via"], label: "{via}" }], at: at(6, 2, 6, 4) },
      { id: "classes", kind: "bars", title: t("Letture per classificazione"), unit: "count", q: { name: "reads", agg: "sum", groupBy: ["classification"], label: "{classification}" }, reduce: "sum", at: at(0, 6, 4, 4) },
      {
        id: "failures",
        kind: "table",
        title: t("Accessi negati e errori (7 giorni)"),
        stat: "security",
        path: "failures",
        columns: [{ key: "at", label: t("Quando"), unit: "date" }, { key: "action", label: t("Azione") }, { key: "who", label: t("Chi") }, { key: "ip", label: t("Indirizzo") }],
        at: at(4, 6, 8, 4),
        drill: AUDIT,
      },
      { id: "blocked", kind: "table", title: t("Host bloccati"), stat: "security", path: "blocked", columns: [{ key: "host", label: t("Host") }, { key: "n", label: t("Tentativi"), num: true }, { key: "last", label: t("Ultimo"), unit: "date" }], at: at(0, 10, 5, 4) },
      {
        id: "keys",
        kind: "table",
        title: t("Account API"),
        stat: "security",
        path: "apiAccounts",
        columns: [{ key: "name", label: t("Account") }, { key: "clearance", label: t("Livello"), unit: "class" }, { key: "lastSeen", label: t("Ultimo uso"), unit: "date" }],
        at: at(5, 10, 7, 4),
        drill: { kind: "admin", section: "api" },
      },
    ],
  },
  {
    id: "host",
    title: t("Host"),
    description: t("CPU, GPU, temperature, memoria, disco e rete della macchina che ospita il server."),
    icon: "cpu",
    panels: [
      { id: "cpu", kind: "stat", title: "CPU", unit: "percent", q: { name: "host_cpu_percent", agg: "last" }, warn: 75, alert: 92, at: at(0, 0, 2, 2) },
      { id: "gpu", kind: "stat", title: "GPU", unit: "percent", q: { name: "host_gpu_percent", agg: "last" }, at: at(2, 0, 2, 2), help: t("Uso della scheda video (rocm-smi o nvidia-smi). Vuoto se la macchina non ha una GPU.") },
      { id: "cpuTemp", kind: "stat", title: t("Temperatura CPU"), unit: "celsius", q: { name: "host_cpu_temp_c", agg: "last" }, warn: 80, alert: 90, at: at(4, 0, 2, 2), help: t("Sensore k10temp o coretemp (Linux).") },
      { id: "load", kind: "stat", title: t("Carico (1 min)"), unit: "x", q: { name: "host_load1", agg: "last" }, at: at(6, 0, 2, 2), help: t("Processi che vogliono la CPU, in media nell'ultimo minuto: sopra il numero dei core la macchina è in coda.") },
      { id: "mem", kind: "stat", title: t("Memoria usata"), unit: "bytes", q: { name: "host_mem_used_bytes", agg: "last" }, at: at(8, 0, 2, 2) },
      { id: "disk", kind: "stat", title: t("Disco dati usato"), unit: "bytes", q: { name: "host_disk_used_bytes", agg: "last" }, at: at(10, 0, 2, 2) },
      { id: "cpuT", kind: "timeseries", title: "CPU e GPU", unit: "percent", queries: [{ name: "host_cpu_percent", agg: "avg", label: t("CPU") }, { name: "host_gpu_percent", agg: "avg", label: t("GPU") }], at: at(0, 2, 6, 4) },
      { id: "temps", kind: "timeseries", title: t("Temperature"), unit: "celsius", queries: [{ name: "host_cpu_temp_c", agg: "max", label: t("CPU") }, { name: "host_gpu_temp_c", agg: "max", groupBy: ["sensor"], label: t("GPU {sensor}") }], at: at(6, 2, 6, 4) },
      { id: "memT", kind: "timeseries", title: t("Memoria"), unit: "bytes", queries: [{ name: "host_mem_used_bytes", agg: "avg", label: t("server") }, { name: "process_rss_bytes", agg: "avg", label: t("HiveVault") }], at: at(0, 6, 6, 4) },
      { id: "vram", kind: "timeseries", title: t("Memoria video (VRAM)"), unit: "bytes", queries: [{ name: "host_gpu_vram_used_bytes", agg: "max", label: t("usata") }, { name: "host_gpu_vram_total_bytes", agg: "last", label: t("totale") }], at: at(6, 6, 6, 4) },
      { id: "net", kind: "timeseries", title: t("Rete"), unit: "bytesPerSec", queries: [{ name: "host_net_bytes_per_sec", agg: "avg", groupBy: ["dir"], label: "{dir}" }], at: at(0, 10, 6, 4), help: t("Solo su Linux.") },
      { id: "power", kind: "timeseries", title: t("Potenza GPU"), unit: "watt", queries: [{ name: "host_gpu_power_w", agg: "avg", label: t("potenza") }], at: at(6, 10, 6, 4) },
      { id: "diskT", kind: "timeseries", title: t("Disco dati"), unit: "bytes", queries: [{ name: "host_disk_used_bytes", agg: "last", label: t("usato") }, { name: "host_disk_total_bytes", agg: "last", label: t("totale") }], at: at(0, 14, 6, 4) },
      { id: "machine", kind: "table", title: t("Macchina"), stat: "host", path: "info", columns: [{ key: "voce", label: t("Voce") }, { key: "valore", label: t("Valore") }], at: at(6, 14, 6, 4) },
    ],
  },
];
