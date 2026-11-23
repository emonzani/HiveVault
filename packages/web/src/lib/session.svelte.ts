// Logged-in user, vaults and the cloud agent notice (D1). One instance for the whole app.
import { api, ApiError, setCsrf, setUnauthenticatedHandler } from "./api.ts";
import type { Me, Vault } from "./types.ts";
import { ui } from "./ui.svelte.ts";
import { ws } from "./workspace.svelte.ts";

class Session {
  me = $state<Me | null>(null);
  /** undefined = not checked yet. */
  ready = $state(false);
  noticeAckAt = $state<string | null | undefined>(undefined);
  /** Vault shown in the sidebar tree. */
  vaultId = $state<string | null>(null);

  get vaults(): Vault[] {
    return this.me?.vaults ?? [];
  }
  get vault(): Vault | undefined {
    return this.vaults.find((v) => v.id === this.vaultId) ?? this.vaults[0];
  }
  get writable(): Vault[] {
    return this.vaults.filter((v) => v.permission !== "read");
  }
  vaultName(id: string): string {
    return this.vaults.find((v) => v.id === id)?.name ?? id;
  }

  constructor() {
    setUnauthenticatedHandler(() => {
      if (this.me) this.me = null;
      ws.setOwner(null);
    });
  }

  async load(): Promise<void> {
    try {
      const me = await api.get<Me>("/api/auth/me", { quiet401: true });
      this.apply(me);
      const n = await api.get<{ acknowledgedAt: string | null }>("/api/me/notice");
      this.noticeAckAt = n.acknowledgedAt;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      this.me = null;
      ws.setOwner(null);
    } finally {
      this.ready = true;
    }
  }

  apply(me: Me): void {
    this.me = me;
    setCsrf(me.csrf);
    ws.setOwner(me.principal.id);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`cb-vault-${me.principal.id}`);
    } catch {
      /* ignore */
    }
    const own = me.vaults.find((v) => v.kind === "cell" && v.permission === "admin");
    this.vaultId = me.vaults.some((v) => v.id === saved) ? saved : (own?.id ?? me.vaults[0]?.id ?? null);
  }

  selectVault(id: string): void {
    this.vaultId = id;
    try {
      if (this.me) localStorage.setItem(`cb-vault-${this.me.principal.id}`, id);
    } catch {
      /* ignore */
    }
  }

  async acknowledgeNotice(): Promise<void> {
    const r = await api.post<{ acknowledgedAt: string }>("/api/me/notice");
    this.noticeAckAt = r.acknowledgedAt;
  }

  async logout(): Promise<void> {
    // The app leaves the session only when the server confirms the logout. A failed request
    // (network, 429, 5xx) leaves the session cookie valid: the login screen would hide a live
    // session from the next person at this browser. Stay signed in and show the error.
    try {
      await api.post("/api/auth/logout");
    } catch (e) {
      ui.toast((e as Error).message, "error");
      return;
    }
    this.me = null;
    setCsrf(null);
    ws.setOwner(null);
  }
}

export const session = new Session();
