/**
 * Workspace state: one or two panes side by side, each with tabs; every tab has its own
 * back/forward history (Alt+←/→). The address bar shows the active tab (#/p/<id>, #/cerca?q=…),
 * so a link can be shared and a reload opens the same view. The layout is a per-viewer
 * convenience kept in localStorage under the key of the logged-in principal.
 */

import { ADMIN_SECTIONS, type AdminSection, type View } from "./views.ts";
import { t } from "./i18n.ts";
export { ADMIN_SECTIONS, type AdminSection, type View };

const SECTION_IDS = new Set<string>(ADMIN_SECTIONS.map((s) => s.id));

export interface Tab {
  id: string;
  view: View;
  title: string;
  back: View[];
  fwd: View[];
}

export interface Pane {
  tabs: Tab[];
  active: number;
}

/** Tabs of one principal: page titles and search queries are theirs, never the next user's. */
const KEY = "cb-workspace-";
const MAX_TABS = 20;

// older versions kept the tabs of every user of the browser under one key
try {
  localStorage.removeItem("cb-workspace");
} catch {
  /* storage unavailable */
}

let seq = 0;
const tabId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

function defaultTitle(v: View): string {
  switch (v.kind) {
    case "home":
      return t("Nuova scheda");
    case "page":
      return t("Pagina");
    case "search":
      return v.q ? t("Cerca: {q}", { q: v.q }) : t("Cerca");
    case "graph":
      return t("Grafo");
    case "source":
      return t("Sorgente");
    case "inbox":
      return v.tab === "review" ? t("Da rivedere") : t("Inbox");
    case "agent":
      return t("Cosa ha letto l'agente cloud");
    case "history":
      return t("Storico");
    case "account":
      return t("Il mio account");
    case "curator":
      return t("Coda dei curatori");
    case "dream":
      return t("Ciclo notturno");
    case "admin":
      return t("Console · {x}", { x: ADMIN_SECTIONS.find((s) => s.id === v.section)?.label ?? v.section });
    case "dashboard":
      return t("Dashboard");
  }
}

export function viewToHash(v: View): string {
  switch (v.kind) {
    case "home":
      return "#/";
    case "page":
      return `#/p/${encodeURIComponent(v.id)}${v.anchor ? `/${encodeURIComponent(v.anchor)}` : ""}`;
    case "search":
      return `#/cerca${v.q ? `?q=${encodeURIComponent(v.q)}` : ""}`;
    case "graph":
      return "#/grafo";
    case "source":
      return `#/sorgente/${encodeURIComponent(v.id)}${v.chunk ? `/${encodeURIComponent(v.chunk)}` : ""}`;
    case "inbox":
      return v.tab === "review" ? "#/da-rivedere" : "#/inbox";
    case "agent":
      return "#/agente";
    case "history":
      return `#/storico/${encodeURIComponent(v.id)}`;
    case "account":
      return "#/account";
    case "curator":
      return "#/curatori";
    case "dream":
      return "#/notte";
    case "admin":
      return `#/admin/${v.section}${v.id ? `/${encodeURIComponent(v.id)}` : ""}`;
    case "dashboard":
      return `#/dashboard/${encodeURIComponent(v.id)}`;
  }
}

export function hashToView(hash: string): View | null {
  const h = hash.replace(/^#/, "");
  const [path = "", query = ""] = h.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case undefined:
      return { kind: "home" };
    case "p":
      return parts[1] ? { kind: "page", id: parts[1], ...(parts[2] ? { anchor: parts[2] } : {}) } : null;
    case "cerca":
      return { kind: "search", q: q.get("q") ?? "" };
    case "grafo":
      return { kind: "graph" };
    case "sorgente":
      return parts[1] ? { kind: "source", id: parts[1], ...(parts[2] ? { chunk: parts[2] } : {}) } : null;
    case "inbox":
      return { kind: "inbox", tab: "inbox" };
    case "da-rivedere":
      return { kind: "inbox", tab: "review" };
    case "agente":
    case "claude": // links saved before the rename
      return { kind: "agent" };
    case "storico":
      return parts[1] ? { kind: "history", id: parts[1] } : null;
    case "account":
      return { kind: "account" };
    case "curatori":
      return { kind: "curator" };
    case "notte":
      return { kind: "dream" };
    case "admin":
      return { kind: "admin", section: (SECTION_IDS.has(parts[1] ?? "") ? parts[1] : "utenti") as AdminSection, ...(parts[2] ? { id: parts[2] } : {}) };
    case "dashboard":
      return { kind: "dashboard", id: parts[1] ?? "panoramica" };
    default:
      return null;
  }
}

const sameView = (a: View, b: View) => viewToHash(a) === viewToHash(b);

/** Kinds of views renamed after a release: tabs saved by an older version open the new view. */
const RENAMED_KINDS: Record<string, View["kind"]> = { claude: "agent" };

/** A saved view under its current kind, or null when no version of the app knows it. */
function restoreView(v: View): View | null {
  const view = { ...v, kind: RENAMED_KINDS[v.kind as string] ?? v.kind } as View;
  return typeof viewToHash(view) === "string" ? view : null;
}

const home = (): Pane[] => [{ tabs: [{ id: tabId(), view: { kind: "home" }, title: t("Nuova scheda"), back: [], fwd: [] }], active: 0 }];

function load(owner: string): Pane[] {
  try {
    const raw = localStorage.getItem(KEY + owner);
    if (raw) {
      const panes = JSON.parse(raw) as Pane[];
      if (Array.isArray(panes) && panes.length >= 1 && panes.length <= 2 && panes.every((p) => Array.isArray(p.tabs) && p.tabs.length)) {
        // a page title is content; other titles are UI text saved in the language of the last visit
        const restored = panes
          .map((p) => {
            // a tab of a view that no longer exists is dropped, not shown untitled
            const tabs = p.tabs.flatMap((tab) => {
              const view = restoreView(tab.view);
              return view ? [{ ...tab, view, title: view.kind === "page" ? tab.title : defaultTitle(view), back: [], fwd: [] }] : [];
            });
            return { tabs, active: Math.max(0, Math.min(p.active, tabs.length - 1)) };
          })
          .filter((p) => p.tabs.length);
        if (restored.length) return restored;
      }
    }
  } catch {
    /* storage unavailable or corrupt: start clean */
  }
  return home();
}

class Workspace {
  panes = $state<Pane[]>(home());
  focused = $state(0);
  /** Principal whose tabs are saved: null while nobody is logged in. */
  private owner: string | null = null;
  /** Principal whose tabs the panes hold: they stay in memory, unsaved, through a logout. */
  private holder: string | null = null;

  /**
   * The logged-in principal, or null after a logout or an expired session. The shell is not
   * shown while logged out, so the panes stay: the same user who logs in again finds tabs,
   * history and focus unchanged. Another user gets their own saved tabs, never these.
   */
  setOwner(id: string | null) {
    this.owner = id;
    if (id === null || id === this.holder) return;
    // the address still shows the previous user's active view: it was not chosen by this user
    const left = this.holder === null ? null : viewToHash(this.tab.view);
    this.holder = id;
    this.panes = load(id);
    this.focused = 0;
    if (left !== null && location.hash === left) history.replaceState(null, "", viewToHash(this.tab.view));
  }

  get pane(): Pane {
    return this.panes[Math.min(this.focused, this.panes.length - 1)]!;
  }
  get tab(): Tab {
    return this.pane.tabs[this.pane.active]!;
  }

  private save() {
    if (this.owner === null) return;
    try {
      localStorage.setItem(KEY + this.owner, JSON.stringify(this.panes.map((p) => ({ active: p.active, tabs: p.tabs.map((t) => ({ id: t.id, view: t.view, title: t.title })) }))));
    } catch {
      /* ignore */
    }
  }

  private syncHash() {
    const h = viewToHash(this.tab.view);
    if (location.hash !== h) history.replaceState(null, "", h);
    this.save();
  }

  /** Opens a view: in the current tab (default), in a new tab, or in the other pane. */
  open(view: View, where: "here" | "tab" | "split" = "here") {
    if (where === "split") {
      if (this.panes.length === 1) this.panes.push({ tabs: [], active: 0 });
      const target = this.focused === 0 ? 1 : 0;
      this.focused = target;
      where = "tab";
    }
    const pane = this.pane;
    if (where === "tab" || !pane.tabs.length) {
      // an existing tab with the same view gets the focus instead of a copy
      const i = pane.tabs.findIndex((t) => sameView(t.view, view));
      if (i >= 0) pane.active = i;
      else {
        pane.tabs.splice(pane.active + 1, 0, { id: tabId(), view, title: defaultTitle(view), back: [], fwd: [] });
        pane.active = Math.min(pane.active + 1, pane.tabs.length - 1);
        if (pane.tabs.length > MAX_TABS) pane.tabs.splice(0, 1), pane.active--;
      }
    } else {
      const t = pane.tabs[pane.active]!;
      if (!sameView(t.view, view)) {
        t.back.push(t.view);
        if (t.back.length > 100) t.back.shift();
        t.fwd = [];
        t.view = view;
        t.title = defaultTitle(view);
      } else if (view.kind === "page" && t.view.kind === "page") {
        t.view = view; // same page, new anchor or mode
      }
    }
    this.syncHash();
  }

  /** Replaces the current view without a history entry (e.g. toggling edit mode). */
  replace(view: View) {
    this.tab.view = view;
    this.syncHash();
  }

  setTitle(id: string, title: string) {
    for (const p of this.panes) for (const t of p.tabs) if (t.id === id && t.title !== title) t.title = title;
    this.save();
  }

  back() {
    const t = this.tab;
    const v = t.back.pop();
    if (!v) return;
    t.fwd.push(t.view);
    t.view = v;
    this.syncHash();
  }

  forward() {
    const t = this.tab;
    const v = t.fwd.pop();
    if (!v) return;
    t.back.push(t.view);
    t.view = v;
    this.syncHash();
  }

  activate(pane: number, index: number) {
    this.focused = pane;
    this.panes[pane]!.active = index;
    this.syncHash();
  }

  focus(pane: number) {
    if (this.focused === pane) return;
    this.focused = pane;
    this.syncHash();
  }

  close(pane: number, index: number) {
    const p = this.panes[pane]!;
    p.tabs.splice(index, 1);
    if (!p.tabs.length) {
      if (this.panes.length > 1) {
        this.panes.splice(pane, 1);
        this.focused = 0;
      } else p.tabs.push({ id: tabId(), view: { kind: "home" }, title: t("Nuova scheda"), back: [], fwd: [] });
    }
    p.active = Math.min(p.active >= index ? Math.max(p.active - 1, 0) : p.active, Math.max(p.tabs.length - 1, 0));
    this.syncHash();
  }

  newTab() {
    this.pane.tabs.splice(this.pane.active + 1, 0, { id: tabId(), view: { kind: "home" }, title: t("Nuova scheda"), back: [], fwd: [] });
    this.pane.active++;
    this.syncHash();
  }

  /** Ctrl+\: splits the active tab into a second pane, or merges the panes back. */
  toggleSplit() {
    if (this.panes.length === 2) {
      const [a, b] = this.panes as [Pane, Pane];
      for (const t of b.tabs) if (!a.tabs.some((x) => sameView(x.view, t.view))) a.tabs.push(t);
      this.panes.splice(1, 1);
      this.focused = 0;
    } else {
      const v = this.tab.view;
      this.panes.push({ tabs: [{ id: tabId(), view: v, title: this.tab.title, back: [], fwd: [] }], active: 0 });
      this.focused = 1;
    }
    this.syncHash();
  }

  cycleTab(step: number) {
    const p = this.pane;
    p.active = (p.active + step + p.tabs.length) % p.tabs.length;
    this.syncHash();
  }

  /** Browser navigation (typed URL, shared link): the hash opens in the active tab. */
  fromHash() {
    const v = hashToView(location.hash);
    if (!v) return;
    if (!sameView(v, this.tab.view)) this.open(v);
    // same view under another spelling (an old link): the address takes the current one
    else if (location.hash !== viewToHash(v)) history.replaceState(null, "", viewToHash(v));
  }
}

export const ws = new Workspace();
