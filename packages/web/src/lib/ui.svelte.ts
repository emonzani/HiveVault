// Global UI state: dialogs, palette, sidebars, toasts, favorites.
import type { View } from "./workspace.svelte.ts";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "ok" | "error";
  action?: { label: string; run: () => void };
}

export interface Favorite {
  id: string;
  title: string;
}

class Ui {
  palette = $state<null | "commands" | "switcher">(null);
  upload = $state<{ files?: File[] } | null>(null);
  newPage = $state<{ title?: string; vaultId?: string } | null>(null);
  /** Narrow screens (phones): the sidebar is a drawer over the content, closed at start. */
  readonly narrowQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 760px)") : null;
  narrow = $state(this.narrowQuery?.matches ?? false);
  leftOpen = $state(!(this.narrowQuery?.matches ?? false));
  rightOpen = $state(true);
  toasts = $state<Toast[]>([]);
  favorites = $state<Favorite[]>([]);
  private seq = 0;

  constructor() {
    this.narrowQuery?.addEventListener("change", (e) => {
      this.narrow = e.matches;
      this.leftOpen = !e.matches;
    });
  }
  private favKey = "cb-favorites";

  toast(text: string, tone: Toast["tone"] = "info", action?: Toast["action"]) {
    const id = ++this.seq;
    this.toasts.push({ id, text, tone, ...(action ? { action } : {}) });
    setTimeout(() => this.dismiss(id), tone === "error" ? 8000 : 4500);
  }
  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  loadFavorites(userId: string) {
    this.favKey = `cb-favorites-${userId}`;
    try {
      this.favorites = JSON.parse(localStorage.getItem(this.favKey) ?? "[]") as Favorite[];
    } catch {
      this.favorites = [];
    }
  }
  isFavorite(id: string) {
    return this.favorites.some((f) => f.id === id);
  }
  toggleFavorite(f: Favorite) {
    this.favorites = this.isFavorite(f.id) ? this.favorites.filter((x) => x.id !== f.id) : [...this.favorites, f];
    try {
      localStorage.setItem(this.favKey, JSON.stringify(this.favorites));
    } catch {
      /* ignore */
    }
  }
}

export const ui = new Ui();

/** Where a click opens a view: Ctrl/Cmd or middle click → new tab, Shift → other pane. */
export function target(e: MouseEvent | KeyboardEvent): "here" | "tab" | "split" {
  if (e.shiftKey) return "split";
  if (e.ctrlKey || e.metaKey || ("button" in e && e.button === 1)) return "tab";
  return "here";
}

export type { View };
