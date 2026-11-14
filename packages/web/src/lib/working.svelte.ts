// Documents still in the pipeline (GET /api/sources/working), for the tabs, the inbox, the
// source view and the console. The event stream says when a source changes level; the task
// phase (e.g. a compile waiting for the chat model) changes without an event, so the list is
// read again every 10 s, but only while it is not empty.
import { api } from "./api.ts";
import { sourceEvents } from "./events.svelte.ts";

import { t } from "./i18n.ts";
/** The compilation queue of the server and its estimated wait (GET /api/sources/queue, M14). */
export interface CompileQueue {
  waiting: number;
  backlog: number;
  secondsPerSource: number | null;
  measured: number;
  waitMinutes: number | null;
  backlogHours: number | null;
}

/** The estimated wait in words, for the upload dialog. */
export function waitLabel(q: CompileQueue): string {
  if (q.waitMinutes === null) return t("Ti avviso quando le pagine sono pronte. Il tempo di compilazione non è ancora misurato.");
  if (q.waitMinutes <= 1) return t("Pagine pronte tra circa un minuto: ti avviso qui.");
  return t("Pagine pronte tra circa {n} minuti ({waiting} documenti in coda): ti avviso qui.", { n: q.waitMinutes, waiting: q.waiting });
}

/** The queue in words, for the console. */
export function queueLabel(q: CompileQueue): string {
  if (q.secondsPerSource === null) return t("Da compilare: {waiting} in coda. Arretrato degli import: {backlog} documenti. Tempo per documento non ancora misurato.", { waiting: q.waiting, backlog: q.backlog });
  return t("Da compilare: {waiting} in coda, circa {m} minuti. Arretrato degli import: {backlog} documenti, circa {h} ore di modello ({s} s per documento).", {
    waiting: q.waiting,
    m: q.waitMinutes ?? 0,
    backlog: q.backlog,
    h: q.backlogHours ?? 0,
    s: q.secondsPerSource,
  });
}

export interface Working {
  id: string;
  phase: string;
  task: string;
  waitingModel: boolean;
}

/** What the pipeline is doing, in words for people. */
export function phaseLabel(w: Working): string {
  if (w.waitingModel) return w.phase === "ocr" ? t("In attesa del modello OCR") : t("In attesa del modello di chat (un documento alla volta)");
  switch (w.phase) {
    case "parse":
      return t("Lettura del documento");
    case "ocr":
      return t("Lettura delle pagine scansionate (OCR)");
    case "index":
      return t("Preparazione del testo cercabile");
    case "embed":
      return t("Calcolo del significato");
    case "compile":
      return t("Scrittura della pagina con il modello");
    default:
      return t("In lavorazione");
  }
}

class WorkingSources {
  byId = $state<Record<string, Working>>({});
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = -1;
  private running = false;
  private cleanup: (() => void) | null = null;

  has(id: string): boolean {
    return id in this.byId;
  }
  get(id: string): Working | undefined {
    return this.byId[id];
  }
  get count(): number {
    return Object.keys(this.byId).length;
  }

  async refresh(): Promise<void> {
    try {
      const list = await api.get<Working[]>("/api/sources/working", { quiet401: true });
      this.byId = Object.fromEntries(list.map((w) => [w.id, w]));
    } catch {
      /* offline or logged out: keep the last list */
    }
    this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running || !this.count) return;
    this.timer = setTimeout(() => void this.refresh(), 10_000);
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.refresh();
    // a change of level arrives as an event: read the list again (at most once a second)
    this.cleanup = $effect.root(() => {
      $effect(() => {
        const t = sourceEvents.tick;
        if (t === this.lastTick) return;
        this.lastTick = t;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 1000);
      });
    });
  }

  stop() {
    this.running = false;
    this.cleanup?.();
    this.cleanup = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.byId = {};
  }
}

export const working = new WorkingSources();
