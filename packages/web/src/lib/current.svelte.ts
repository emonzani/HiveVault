// The page shown in each tab, published by PageView for the right panel (outline, backlinks,
// local graph, properties) and for the commands of the palette.
import type { FullPage } from "./types.ts";

export interface Shown {
  page: FullPage;
  headings: { id: string; level: number; title: string }[];
}

class Current {
  byTab = $state<Record<string, Shown>>({});
  set(tabId: string, s: Shown) {
    this.byTab[tabId] = s;
  }
  clear(tabId: string) {
    delete this.byTab[tabId];
  }
}

export const current = new Current();

/** Scrolls the page of a tab to a heading or a block and flashes it. */
export function scrollToAnchor(root: HTMLElement | null, anchor: string): void {
  if (!root || !anchor) return;
  const el = root.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
  if (!el) return;
  const target = el.classList.contains("block-id") ? (el.closest("p, li, blockquote, table") as HTMLElement | null) ?? el : el;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  target.classList.remove("flash");
  void target.offsetWidth;
  target.classList.add("flash");
}
