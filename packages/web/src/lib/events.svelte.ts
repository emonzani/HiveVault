// Server-sent events of the sources (status and level changes), shared by the inbox, the
// upload dialog and the sidebar counters. The browser reconnects by itself (retry: 3000).

export interface SourceEvent {
  id: string;
  vault: string;
  status: string;
  level: number;
}

class SourceEvents {
  /** Last known status per source id (only sources that changed since the app opened). */
  status = $state<Record<string, SourceEvent>>({});
  /** Increments on every event: views that list sources reload when it changes. */
  tick = $state(0);
  connected = $state(false);
  private es: EventSource | null = null;
  /** Sources uploaded from this tab, by id: their name for the message when they reach I3 (M14). */
  private watched = new Map<string, string>();
  /** Called once when a watched source reaches I3. */
  onCompiled: ((id: string, name: string) => void) | null = null;

  watch(id: string, name: string) {
    this.watched.set(id, name);
  }

  start() {
    if (this.es || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events", { withCredentials: true });
    es.addEventListener("open", () => (this.connected = true));
    es.addEventListener("error", () => (this.connected = false));
    es.addEventListener("source", (m) => {
      try {
        const e = JSON.parse((m as MessageEvent<string>).data) as SourceEvent;
        this.status[e.id] = e;
        this.tick++;
        const name = e.level === 3 ? this.watched.get(e.id) : undefined;
        if (name !== undefined) {
          this.watched.delete(e.id);
          this.onCompiled?.(e.id, name);
        }
      } catch {
        /* ignore */
      }
    });
    this.es = es;
  }

  stop() {
    this.es?.close();
    this.es = null;
    this.connected = false;
    this.watched.clear();
  }
}

export const sourceEvents = new SourceEvents();
