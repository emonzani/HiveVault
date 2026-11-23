// Open tabs belong to the logged-in principal: the page titles and search queries of one user
// never reach the next user of the same browser. The same user who logs in again keeps tabs,
// history and focus.
// workspace.svelte.ts uses Svelte runes and the root vitest config has no Svelte plugin: $state is
// replaced by the identity function. The module is imported through a non-literal path, so the
// root lint (no DOM or Svelte types) does not check it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface View {
  kind: string;
  id?: string;
  q?: string;
}
interface Tab {
  id: string;
  view: View;
  title: string;
  back: View[];
}
interface Workspace {
  panes: { tabs: Tab[]; active: number }[];
  focused: number;
  readonly tab: Tab;
  setOwner(id: string | null): void;
  open(view: View, where?: "here" | "tab" | "split"): void;
  setTitle(id: string, title: string): void;
  focus(pane: number): void;
  back(): void;
}

const MODULE = "../src/lib/workspace.svelte.ts";
const store = new Map<string, string>();
const loc = { hash: "" };
let ws: Workspace;

/** A new page load: fresh module state, same browser storage. */
async function reload(hash = "") {
  vi.resetModules();
  loc.hash = hash;
  ws = ((await import(MODULE)) as { ws: Workspace }).ws;
}

/** A user who reads a page of their personal vault and searches. */
function workOfA() {
  ws.setOwner("usr_a");
  ws.open({ kind: "page", id: "pagina-a" });
  ws.setTitle(ws.tab.id, "Diario personale di A");
  ws.open({ kind: "search", q: "stipendio di A" }, "tab");
}

const titles = () => ws.panes.flatMap((p) => p.tabs.map((t) => t.title));

beforeAll(() => {
  vi.stubGlobal("$state", <T>(v: T) => v);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", { replaceState: (_s: unknown, _t: string, url: string) => void (loc.hash = url) });
});

beforeEach(async () => {
  store.clear();
  await reload();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("workspace of the logged-in principal", () => {
  it("a different user on the same page gets none of the previous user's tabs", async () => {
    workOfA();
    expect(loc.hash).toBe("#/cerca?q=stipendio%20di%20A");
    ws.setOwner(null); // logout
    ws.setOwner("usr_b");
    expect(titles()).toEqual(["Nuova scheda"]);
    expect(JSON.stringify(ws.panes)).not.toMatch(/pagina-a|stipendio|Diario/);
    expect(ws.focused).toBe(0);
    // the address showed A's search: it shows B's active tab
    expect(loc.hash).toBe("#/");
    ws.open({ kind: "graph" }, "tab");
    expect(store.get("cb-workspace-usr_b")).not.toMatch(/pagina-a|stipendio|Diario/);
  });

  it("after a reload each user gets only their own saved tabs", async () => {
    workOfA();
    ws.setOwner(null);
    await reload("#/");
    ws.setOwner("usr_b");
    expect(titles()).toEqual(["Nuova scheda"]);
    await reload("#/");
    ws.setOwner("usr_a");
    expect(titles()).toEqual(["Diario personale di A", "Cerca: stipendio di A"]);
  });

  it("the same user who logs in again keeps tabs, back history, focus and address", () => {
    ws.setOwner("usr_a");
    ws.open({ kind: "page", id: "p1" });
    ws.open({ kind: "page", id: "p2" });
    ws.open({ kind: "graph" }, "split");
    const panes = ws.panes;
    expect(ws.focused).toBe(1);
    ws.setOwner(null); // logout or expired session (401)
    ws.setOwner("usr_a");
    expect(ws.panes).toBe(panes);
    expect(ws.focused).toBe(1);
    expect(loc.hash).toBe("#/grafo");
    ws.focus(0);
    ws.back();
    expect(ws.tab.view).toEqual({ kind: "page", id: "p1" });
  });

  it("saves nothing while logged out", () => {
    ws.setOwner("usr_a");
    ws.open({ kind: "page", id: "p1" });
    const saved = store.get("cb-workspace-usr_a");
    ws.setOwner(null);
    // a page that finishes loading after the logout
    ws.setTitle(ws.tab.id, "Titolo arrivato dopo");
    expect(store.get("cb-workspace-usr_a")).toBe(saved);
    expect([...store.keys()]).toEqual(["cb-workspace-usr_a"]);
  });

  it("keeps a link opened before the login, also after another user's logout", async () => {
    await reload("#/p/condivisa");
    ws.setOwner("usr_b");
    expect(loc.hash).toBe("#/p/condivisa");
    ws.setOwner(null);
    workOfA();
    ws.setOwner(null);
    loc.hash = "#/p/scelta-da-b"; // typed by the next user on the login screen
    ws.setOwner("usr_b");
    expect(loc.hash).toBe("#/p/scelta-da-b");
  });

  it("drops the tabs that older versions saved under one key for every user", async () => {
    store.set("cb-workspace", JSON.stringify([{ active: 0, tabs: [{ id: "t1", view: { kind: "page", id: "pagina-a" }, title: "Diario personale di A" }] }]));
    await reload();
    expect(store.has("cb-workspace")).toBe(false);
    ws.setOwner("usr_b");
    expect(titles()).toEqual(["Nuova scheda"]);
  });
});
