/**
 * Page cache: opening a page that was seen or hovered before needs no request (plan target:
 * page open < 100 ms perceived). Entries are refreshed in the background when older than
 * 30 s, and dropped after a save or a delete.
 */
import { api } from "./api.ts";
import type { FullPage, ReadResult } from "./types.ts";

const MAX = 200;
const FRESH_MS = 30_000;

interface Entry<T> {
  at: number;
  value?: T;
  pending?: Promise<T>;
}

class Cache<T> {
  private map = new Map<string, Entry<T>>();
  constructor(private readonly fetcher: (id: string) => Promise<T>) {}

  peek(id: string): T | undefined {
    return this.map.get(id)?.value;
  }

  get(id: string, force = false): Promise<T> {
    const e = this.map.get(id);
    if (e?.pending) return e.pending;
    if (e?.value !== undefined && !force && Date.now() - e.at < FRESH_MS) return Promise.resolve(e.value);
    const pending = this.fetcher(id).then(
      (value) => {
        this.map.delete(id);
        this.map.set(id, { at: Date.now(), value });
        if (this.map.size > MAX) this.map.delete(this.map.keys().next().value!);
        return value;
      },
      (err: unknown) => {
        if (e?.value !== undefined) this.map.set(id, { at: e.at, value: e.value });
        else this.map.delete(id);
        throw err;
      },
    );
    this.map.set(id, { at: e?.at ?? 0, ...(e?.value !== undefined ? { value: e.value } : {}), pending });
    return pending;
  }

  drop(id: string) {
    this.map.delete(id);
  }
  clear() {
    this.map.clear();
  }
}

export const pageCache = new Cache<FullPage>((id) => api.get<FullPage>(`/api/pages/${encodeURIComponent(id)}/full`));
/** Short reads for hover previews. */
export const previewCache = new Cache<ReadResult>((id) => api.get<ReadResult>(`/api/pages/${encodeURIComponent(id)}?maxTokens=260`));

/** Bumped after every save, so open views of other pages refresh their links. */
class PageEvents {
  saved = $state(0);
  lastId = $state<string | null>(null);
  notify(id: string) {
    pageCache.drop(id);
    previewCache.drop(id);
    this.lastId = id;
    this.saved++;
  }
}
export const pageEvents = new PageEvents();

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
/** Prefetch on hover (after a short pause, so a mouse passing over a list costs nothing). */
export function prefetch(id: string): void {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => void pageCache.get(id).catch(() => {}), 90);
}
