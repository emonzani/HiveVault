/**
 * Dream cycle (plan §5): a durable task per vault and night, with the 12 steps of the plan.
 *
 * - Every call of the phase "step" does one bounded batch of the current step and commits the
 *   state (step, cursor, report): a killed worker continues from the last batch.
 * - The cycle works only inside the night window (DREAM_WINDOW, e.g. 22:00-06:00) and within a
 *   budget of time and model tokens per vault and night. When the window closes or the budget
 *   ends, the task sleeps until the next window and continues from the same step and cursor.
 * - The scheduler task wakes at the start of every window, submits one cycle per vault (cells
 *   first, hive spaces after) and does the global upkeep.
 *
 * Model calls go through the dispatcher at background priority (invariant 2). Without a chat
 * model the model steps degrade: duplicates go to the curator queue, tldr are left as they are.
 */
import type { Sql } from "@cb/db";
import { EmbeddingIndexer, PageStore } from "@cb/brain";
import { EXTRACT_POOL, type ChatRequest, type ModelDispatcher } from "@cb/models";
import { createLogger, metrics } from "@cb/shared";
import { defineTask, submitTask, type PhaseContext, type TaskDefinition } from "@cb/tasks";
import { claimHash, syncClaims } from "./claims.ts";
import {
  buildIndexes,
  checkBlobs,
  crosslinkBatch,
  EDITABLE,
  findDuplicates,
  globalUpkeep,
  linkTargets,
  lintVault,
  mergePages,
  MergeVisibilityError,
  pickKeeper,
  updateImportance,
  vacuumVault,
  type CrosslinkCursor,
  type UpkeepOptions,
} from "./maintenance.ts";
import { feedsOf, promoteSpace, upsertCuratorItem } from "./promote.ts";

const log = createLogger("dream");

export interface DreamDeps {
  sql: Sql;
  pages: PageStore;
  dispatcher?: ModelDispatcher;
  /** Embedding indexer of the configured model, or null when no embedding model is set. */
  indexer?: () => EmbeddingIndexer | null;
  reingest?: (sourceId: string) => Promise<string>;
  compileNow?: (sourceId: string, priority: number) => Promise<string>;
  /** Current parser versions ("pdf" → "1"): sources parsed by an older version are parsed again. */
  parserVersions?: Record<string, string>;
  /** True when an OCR endpoint answers: scans stored without OCR are read again. */
  ocrAvailable?: () => boolean;
  readBlob?: (vaultId: string, sha: string) => Promise<Buffer>;
  /** Use the chat model for duplicates and tldr (default: true when a dispatcher is given). */
  useModel?: boolean;
  /** Night window, local time "HH:MM-HH:MM" (default 22:00-06:00). */
  window?: string;
  budget?: { minutes?: number; tokens?: number };
  /** Sources compiled (I3) per vault and night from the backlog. */
  compilePerNight?: number;
  /** Clock (tests). */
  now?: () => Date;
  name?: string;
  /**
   * Settings changed from the console, read at every step: they override `window`, `budget`,
   * `compilePerNight` and `useModel` without a restart.
   */
  live?: () => Partial<{ window: string; minutes: number; tokens: number; compilePerNight: number; useModel: boolean }>;
}

/** The settings in force now: console settings over the startup options. */
function current(deps: DreamDeps) {
  const l = deps.live?.() ?? {};
  return {
    window: l.window ?? deps.window ?? "22:00-06:00",
    budgetMs: (l.minutes ?? deps.budget?.minutes ?? 120) * 60_000,
    budgetTokens: l.tokens ?? deps.budget?.tokens ?? 300_000,
    compilePerNight: l.compilePerNight ?? deps.compilePerNight ?? 20,
    useModel: l.useModel ?? deps.useModel ?? true,
  };
}

export interface DreamInput {
  vaultId: string;
  /** Date of the night (start of the window), YYYY-MM-DD. */
  night: string;
  /** Started by an administrator: runs now, also outside the window (the budget still applies). */
  manual?: boolean;
  /** Steps 4 and 6 look at every page of the vault, not only the pages changed since the last cycle. */
  full?: boolean;
}

type Report = Record<string, Record<string, number | string>>;

export interface DreamState {
  step: number;
  cursor: unknown;
  report: Report;
  /** Start of the current working session (ms) and the model tokens it used. */
  session: { start: number; tokens: number } | null;
  sessions: number;
  /** Start of the last finished cycle of the vault: steps 4 and 6 look at pages changed since. */
  since: string | null;
}

export interface DreamResult {
  vaultId: string;
  night: string;
  sessions: number;
  report: Report;
}

interface StepCtx {
  deps: DreamDeps;
  vaultId: string;
  kind: "cell" | "space";
  cursor: unknown;
  since: string | null;
  signal: AbortSignal;
  night: string;
}
interface StepOut {
  done: boolean;
  cursor?: unknown;
  report?: Record<string, number | string>;
  tokens?: number;
}
type Step = { name: string; title: string; run: (c: StepCtx) => Promise<StepOut> };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export function parseWindow(w = "22:00-06:00"): { start: number; end: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(w.trim());
  if (!m) throw new Error(`DREAM_WINDOW non valida: ${w}`);
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}
const minutes = (d: Date) => d.getHours() * 60 + d.getMinutes();
export function inWindow(d: Date, w: string): boolean {
  const { start, end } = parseWindow(w);
  const t = minutes(d);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}
/** Next start of the window after `d` (strictly later). */
export function nextWindowStart(d: Date, w: string): Date {
  const { start } = parseWindow(w);
  const n = new Date(d);
  n.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (n.getTime() <= d.getTime()) n.setDate(n.getDate() + 1);
  return n;
}
/** Date of the night `d` belongs to: the day the window started. */
export function nightOf(d: Date, w: string): string {
  const { start, end } = parseWindow(w);
  const s = new Date(d);
  if (start > end && minutes(d) < end) s.setDate(s.getDate() - 1);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
}

export class DreamBusyError extends Error {}
export class DreamVaultError extends Error {}

/**
 * Starts the cycle of a vault now, for an administrator (route or CLI). The vault is given by
 * id or slug; an unknown one is refused (DreamVaultError) before a task exists. The run of this
 * night is replaced when it is finished; a running or paused one is refused (DreamBusyError).
 */
export async function startDream(
  sql: Sql,
  dream: DreamTask,
  o: { vaultId: string; window: string; full?: boolean; now?: Date },
): Promise<{ taskId: string; night: string; vaultId: string }> {
  const [vault] = await sql<{ id: string }[]>`select id from vaults where id = ${o.vaultId} or slug = ${o.vaultId}`;
  if (!vault) throw new DreamVaultError(`Vault sconosciuto: ${o.vaultId}.`);
  const vaultId = vault.id;
  const night = nightOf(o.now ?? new Date(), o.window);
  const [running] = await sql<{ status: string }[]>`select status from dream_runs where vault_id = ${vaultId} and night = ${night}`;
  if (running && running.status !== "done" && running.status !== "failed") throw new DreamBusyError("Il ciclo di questa notte è già in corso o in pausa.");
  if (running) await sql`delete from dream_runs where vault_id = ${vaultId} and night = ${night}`;
  const t = await submitTask(sql, dream, { vaultId, night, manual: true, full: o.full === true }, { requestId: `dream:${vaultId}:manual:${Date.now()}`, priority: 2 });
  return { taskId: t.id, night, vaultId };
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

async function askJson<T>(d: ModelDispatcher, system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<{ value: T | null; tokens: number }> {
  // short JSON answers: no reasoning first, or it uses the whole token budget
  const req: ChatRequest = { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens, temperature: 0, thinking: false };
  // a small extraction model serves these answers when one is configured (M4)
  const r = await d.chat(req, { priority: 2, signal, pool: EXTRACT_POOL });
  const tokens = r.usage.promptTokens + r.usage.completionTokens;
  const text = r.content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { value: null, tokens };
  try {
    return { value: JSON.parse(m[0]) as T, tokens };
  } catch {
    return { value: null, tokens };
  }
}

const numbersOf = (s: string) => new Set((s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/[.,]/g, "")));

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const STEPS: Step[] = [
  {
    name: "reparse",
    title: "Nuova lettura delle sorgenti con parser aggiornati",
    async run({ deps, vaultId, cursor }): Promise<StepOut> {
      if (!deps.reingest || !deps.parserVersions) return { done: true, report: { saltato: "parser non configurati" } };
      const ocr = deps.ocrAvailable?.() ?? false;
      const rows = await deps.sql<{ id: string; pv: string; scan: boolean }[]>`
        select id, parser_version as pv, coalesce(meta->'warnings' ?| array['needs_ocr', 'ocr_unavailable'], false) as scan from sources
        where vault_id = ${vaultId} and parser_version is not null and status not in ('failed', 'unsupported') and id > ${(cursor as string) ?? ""}
        order by id limit 500`;
      let queued = 0;
      for (const r of rows) {
        const [parser, version] = r.pv.split("@");
        const current = deps.parserVersions[parser!];
        if ((current && current !== version) || (ocr && r.scan)) {
          await deps.reingest(r.id);
          queued++;
        }
      }
      return { done: rows.length < 500, cursor: rows.at(-1)?.id ?? cursor, report: { controllate: rows.length, rilette: queued } };
    },
  },
  {
    name: "backlog",
    title: "Avanzamento del backlog I2/I3",
    async run({ deps, vaultId, cursor, signal }): Promise<StepOut> {
      const part = (cursor as string) ?? "embed";
      if (part === "embed") {
        const indexer = deps.indexer?.();
        if (!indexer) return { done: false, cursor: "compile", report: { embedding: "modello non configurato" } };
        const r = await indexer.run(vaultId, 2000, signal);
        return { done: false, cursor: r.remaining > 0 && r.embedded + r.reused > 0 ? "embed" : "compile", report: { vettori: r.embedded, riusati: r.reused } };
      }
      if (!deps.compileNow) return { done: true };
      const rows = await deps.sql<{ id: string }[]>`
        select s.id from sources s
        where s.vault_id = ${vaultId} and s.level between 1 and 2 and s.status not in ('failed', 'unsupported') and (s.compile or s.demand > 0)
          and not exists (select 1 from tasks t where t.id = s.task_id and t.status not in ('done', 'failed', 'cancelled'))
        order by s.demand desc, s.priority, s.created_at limit ${current(deps).compilePerNight}`;
      for (const r of rows) await deps.compileNow(r.id, 2);
      return { done: true, report: { compilazioni: rows.length } };
    },
  },
  {
    name: "dedup",
    title: "Deduplica delle entità",
    async run({ deps, vaultId, cursor, signal }): Promise<StepOut> {
      const { pairs, next } = await findDuplicates(deps.sql, vaultId, { after: (cursor as string) ?? "", limit: 100 });
      let merged = 0;
      let queued = 0;
      let tokens = 0;
      const gone = new Set<string>();
      for (const p of pairs) {
        if (gone.has(p.a.id) || gone.has(p.b.id)) continue;
        let same = p.certain;
        let confidence = p.certain ? 1 : 0;
        if (!same && deps.dispatcher && current(deps).useModel) {
          const r = await askJson<{ same: boolean; confidence: number }>(
            deps.dispatcher,
            "Decidi se due pagine di un wiki aziendale parlano della stessa entità. Rispondi solo con JSON: {\"same\": true|false, \"confidence\": 0..1}.",
            `A: «${p.a.title}» — ${p.a.tldr}\nB: «${p.b.title}» — ${p.b.tldr}`,
            200,
            signal,
          );
          tokens += r.tokens;
          same = r.value?.same === true;
          confidence = Number(r.value?.confidence ?? 0);
        }
        if (same && confidence >= 0.9) {
          const [keep, drop] = await pickKeeper(deps.sql, p.a.id, p.b.id);
          try {
            await mergePages(deps.sql, deps.pages, keep, drop);
            gone.add(drop);
            merged++;
            continue;
          } catch (e) {
            // the page to remove is private and the kept one is not: a curator decides (queued below)
            if (!(e instanceof MergeVisibilityError)) throw e;
          }
        }
        if (p.similarity >= 0.7 || same) {
          await upsertCuratorItem(deps.sql, vaultId, "duplicate", claimHash(`dup|${[p.a.id, p.b.id].sort().join("|")}`), p.a.title, null, {
            a: p.a,
            b: p.b,
            similarity: Math.round(p.similarity * 100) / 100,
            confidence,
          });
          queued++;
        }
      }
      // M19: duplicates found at night, merged or left to the curators
      metrics.inc("dream_duplicates", { outcome: "merged" }, merged);
      metrics.inc("dream_duplicates", { outcome: "queued" }, queued);
      return { done: !next, cursor: next, tokens, report: { unite: merged, "da rivedere": queued } };
    },
  },
  {
    name: "crosslink",
    title: "Collegamento delle menzioni",
    async run({ deps, vaultId, cursor, since }): Promise<StepOut> {
      return crosslinkBatch(deps.sql, deps.pages, vaultId, cursor as CrosslinkCursor | null, since, { codeAliases: true });
    },
  },
  {
    name: "lint",
    title: "Controlli: orfane, link rotti, pagine stantie, contraddizioni",
    async run({ deps, vaultId }): Promise<StepOut> {
      await syncClaims(deps.sql, { vaultIds: [vaultId] });
      const r = await lintVault(deps.sql, deps.pages, vaultId);
      return { done: true, report: { orfane: r.orphans, "link rotti": r.brokenLinks, "da aggiornare": r.stale, contraddizioni: r.contradictions } };
    },
  },
  {
    name: "tldr",
    title: "Sintesi delle pagine cambiate",
    async run({ deps, vaultId, cursor, since, signal }): Promise<StepOut> {
      if (!deps.dispatcher || !current(deps).useModel) return { done: true, report: { saltato: "modello di chat non usato" } };
      const rows = await deps.sql<{ id: string }[]>`
        select id from pages
        where vault_id = ${vaultId} and split_part(type, '/', 1) = any(${EDITABLE}) and not (frontmatter ? 'tldr') and tokens > 120
          and path not like '\\_inbox/%' and (${since}::timestamptz is null or updated_at > ${since}::timestamptz) and id > ${(cursor as string) ?? ""}
        order by id limit 5`;
      let written = 0;
      let rejected = 0;
      let tokens = 0;
      for (const r of rows) {
        const page = await PageStore.get(deps.sql, r.id);
        if (!page) continue;
        const res = await askJson<{ tldr: string }>(
          deps.dispatcher,
          "Scrivi la sintesi (tldr) di una pagina di wiki aziendale: una frase in italiano, al massimo 200 caratteri, solo fatti presenti nel testo, senza citazioni. Rispondi solo con JSON: {\"tldr\": \"...\"}.",
          `Titolo: ${page.title}\n\n${page.body.slice(0, 6000)}`,
          300,
          signal,
        );
        tokens += res.tokens;
        const t = res.value?.tldr?.replace(/\s+/g, " ").trim() ?? "";
        // no new numbers: every number of the tldr must be in the page
        const body = numbersOf(page.body);
        const ok = t.length >= 20 && t.length <= 240 && !t.includes("\n") && [...numbersOf(t)].every((n) => body.has(n));
        if (!ok) {
          rejected++;
          continue;
        }
        await deps.pages.upsert({ vaultId, id: page.id, path: page.path, frontmatter: { ...page.frontmatter, tldr: t }, body: page.body, author: "dream:tldr" });
        written++;
      }
      return { done: rows.length < 5, cursor: rows.at(-1)?.id ?? cursor, tokens, report: { sintesi: written, scartate: rejected } };
    },
  },
  {
    name: "promote",
    title: "Promozione all'alveare",
    async run({ deps, vaultId, kind, cursor }): Promise<StepOut> {
      if (kind !== "space" || !(await feedsOf(deps.sql, vaultId)).length) return { done: true, report: { saltato: kind === "space" ? "nessuna cella collegata" : "cella" } };
      const r = await promoteSpace(deps.sql, deps.pages, vaultId, { after: (cursor as string) ?? "", limit: 200 });
      const cleanup = r.next ? null : await promoteSpace(deps.sql, deps.pages, vaultId, { cleanup: true });
      return {
        done: !r.next,
        cursor: r.next,
        report: { soggetti: r.subjects, scritte: r.written, invariate: r.unchanged, rimosse: cleanup?.removed ?? 0, conflitti: r.conflicts, decisi: r.decided },
      };
    },
  },
  {
    name: "importance",
    title: "Importanza e decadimento",
    async run({ deps, vaultId }): Promise<StepOut> {
      return { done: true, report: { aggiornate: await updateImportance(deps.sql, vaultId) } };
    },
  },
  {
    name: "indexes",
    title: "Indici per categoria e llms.txt",
    async run({ deps, vaultId }): Promise<StepOut> {
      return { done: true, report: { pagine: (await buildIndexes(deps.sql, vaultId)).pages } };
    },
  },
  {
    name: "database",
    title: "Manutenzione del database",
    async run({ deps, vaultId }): Promise<StepOut> {
      const r = await vacuumVault(deps.sql, vaultId);
      return { done: true, report: { partizione: r.partition, vacuum: r.vacuumed ? "sì" : "no", "righe morte": r.dead } };
    },
  },
  {
    name: "backup",
    title: "Verifica del raw store e dei backup",
    async run({ deps, vaultId }): Promise<StepOut> {
      const blobs = deps.readBlob ? await checkBlobs(deps.sql, deps.readBlob, vaultId) : { checked: 0, failed: [] as string[] };
      return { done: true, report: { "originali verificati": blobs.checked, "originali illeggibili": blobs.failed.length, pgbackrest: "non configurato (fase 8)" } };
    },
  },
  {
    name: "report",
    title: "Rapporto",
    async run() {
      return { done: true };
    },
  },
];

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

function merge(report: Report, step: string, add?: Record<string, number | string>): Report {
  if (!add) return report;
  const cur = { ...(report[step] ?? {}) };
  for (const [k, v] of Object.entries(add)) cur[k] = typeof v === "number" && typeof cur[k] === "number" ? (cur[k] as number) + v : v;
  return { ...report, [step]: cur };
}

export type DreamTask = TaskDefinition<DreamInput, DreamState, DreamResult>;

export function defineDreamTask(deps: DreamDeps): DreamTask {
  const now = deps.now ?? (() => new Date());

  const runRow = async (ctx: PhaseContext<DreamInput, DreamState, DreamResult>, status: string, s: DreamState) => {
    const { vaultId, night } = ctx.task.input;
    await deps.sql`
      update dream_runs set status = ${status}, step = ${STEPS[Math.min(s.step, STEPS.length - 1)]!.name}, report = ${deps.sql.json(s.report as never)},
             tokens = ${Object.values(s.report).reduce((n, r) => n + (typeof r.token === "number" ? r.token : 0), 0)},
             finished_at = ${status === "done" ? new Date() : null}
      where vault_id = ${vaultId} and night = ${night}`;
  };

  return defineTask<DreamInput, DreamState, DreamResult>({
    name: deps.name ?? "dream",
    version: 1,
    firstPhase: "start",
    maxAttempts: 5,
    initial: () => ({ step: 0, cursor: null, report: {}, session: null, sessions: 0, since: null }),
    phases: {
      async start(ctx) {
        const { vaultId, night } = ctx.task.input;
        const [last] = await deps.sql<{ at: Date }[]>`
          select started_at as at from dream_runs where vault_id = ${vaultId} and status = 'done' order by night desc limit 1`;
        await ctx.effectTx("run-row", (tx) => tx`
          insert into dream_runs (id, vault_id, night, task_id, status) values (${`drm_${ctx.task.id.slice(4)}`}, ${vaultId}, ${night}, ${ctx.task.id}, 'running')
          on conflict (vault_id, night) do update set task_id = excluded.task_id, status = 'running'`);
        return ctx.next("step", { ...ctx.task.state, since: last && !ctx.task.input.full ? last.at.toISOString() : null });
      },

      async step(ctx) {
        let s = ctx.task.state;
        const { vaultId, night } = ctx.task.input;
        const t = now();
        const { window, budgetMs, budgetTokens } = current(deps);
        const over = s.session && (t.getTime() - s.session.start > budgetMs || s.session.tokens > budgetTokens);
        if ((!ctx.task.input.manual && !inWindow(t, window)) || over) {
          const until = nextWindowStart(t, window);
          s = { ...s, session: null, report: merge(s.report, "_cycle", { pause: over ? "budget esaurito" : "fuori dalla finestra notturna" }) };
          await runRow(ctx, "paused", s);
          ctx.log.info("dream paused", { vaultId, step: STEPS[s.step]?.name, until: until.toISOString(), reason: over ? "budget" : "window" });
          return ctx.sleepUntil(until, "step", s);
        }
        if (!s.session) s = { ...s, session: { start: t.getTime(), tokens: 0 }, sessions: s.sessions + 1 };

        const step = STEPS[s.step]!;
        const [v] = await deps.sql<{ kind: "cell" | "space" }[]>`select kind from vaults where id = ${vaultId}`;
        if (!v) return ctx.fail("vault non trovato");
        const t0 = Date.now();
        const out = await step.run({ deps, vaultId, kind: v.kind, cursor: s.cursor, since: s.since, signal: ctx.signal, night });
        let report = merge(s.report, step.name, { ...(out.report ?? {}), ms: Date.now() - t0, ...(out.tokens ? { token: out.tokens } : {}) });
        metrics.observe("dream_step_ms", Date.now() - t0, { step: step.name });
        if (out.tokens) metrics.inc("dream_tokens", { step: step.name }, out.tokens);
        const session = { start: s.session!.start, tokens: s.session!.tokens + (out.tokens ?? 0) };

        if (!out.done) {
          s = { ...s, cursor: out.cursor ?? null, report, session };
          await runRow(ctx, "running", s);
          return ctx.next("step", s);
        }
        if (s.step + 1 < STEPS.length) {
          s = { ...s, step: s.step + 1, cursor: null, report, session };
          await runRow(ctx, "running", s);
          return ctx.next("step", s);
        }
        // step 12: the report goes to the vault log and to dream_runs
        report = merge(report, "_cycle", { sessioni: s.sessions, pause: s.sessions > 1 ? `${s.sessions - 1}` : "0" });
        s = { ...s, report, session };
        const summary = STEPS.filter((x) => report[x.name])
          .map((x) => `${x.title}: ${Object.entries(report[x.name]!).filter(([k]) => k !== "ms").map(([k, val]) => `${k} ${val}`).join(", ") || "fatto"}`)
          .join("; ");
        await ctx.effectTx("log", (tx) => tx`
          insert into vault_log (vault_id, kind, title, ref, data)
          values (${vaultId}, 'dream', ${`Ciclo notturno del ${night}`}, ${ctx.task.id}, ${tx.json({ night, sessions: s.sessions, summary, report } as never)})`);
        await runRow(ctx, "done", s);
        log.info("dream done", { vaultId, night, sessions: s.sessions });
        return ctx.done({ vaultId, night, sessions: s.sessions, report });
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  sql: Sql;
  dream: DreamTask;
  window?: string;
  now?: () => Date;
  /** Retention, read at every night (the read retention is a console setting). */
  retention?: () => UpkeepOptions;
  name?: string;
  /** Console setting of the window, read at every wake-up. */
  liveWindow?: () => string | undefined;
}

/**
 * Submits the cycle of every vault for the night `night` (idempotent: one task per vault and
 * night). A vault whose previous cycle is still paused continues that one instead.
 */
export async function scheduleNight(sql: Sql, submit: (input: DreamInput, requestId: string, priority: number) => Promise<unknown>, night: string): Promise<{ submitted: number; continuing: number }> {
  const vaults = await sql<{ id: string; kind: string; open: number }[]>`
    select v.id, v.kind, (select count(*)::int from dream_runs r where r.vault_id = v.id and r.status in ('running', 'paused') and r.night < ${night}) as open
    from vaults v order by v.kind, v.id`;
  let submitted = 0;
  let continuing = 0;
  for (const v of vaults) {
    if (v.open) {
      continuing++;
      continue;
    }
    // cells first: the spaces promote what the cells cleaned up the same night
    await submit({ vaultId: v.id, night }, `dream:${v.id}:${night}`, v.kind === "cell" ? 3 : 4);
    submitted++;
  }
  return { submitted, continuing };
}

export function defineDreamScheduler(d: SchedulerDeps) {
  const now = d.now ?? (() => new Date());
  return defineTask<Record<string, never>, { nights: number }, null>({
    name: d.name ?? "dream-scheduler",
    version: 1,
    firstPhase: "tick",
    initial: () => ({ nights: 0 }),
    phases: {
      async tick(ctx) {
        const t = now();
        const window = d.liveWindow?.() ?? d.window ?? "22:00-06:00";
        if (!inWindow(t, window)) return ctx.sleepUntil(nextWindowStart(t, window), "tick", ctx.task.state);
        const night = nightOf(t, window);
        const r = await ctx.effect(`night:${night}`, () => scheduleNight(d.sql, (input, requestId, priority) => submitTask(d.sql, d.dream, input, { requestId, priority }), night), { replaySafe: true });
        const up = await ctx.effect(`upkeep:${night}`, () => globalUpkeep(d.sql, d.retention?.()), { replaySafe: true });
        ctx.log.info("dream night scheduled", { night, ...r, ...up });
        return ctx.sleepUntil(nextWindowStart(t, window), "tick", { nights: ctx.task.state.nights + 1 });
      },
    },
  });
}
