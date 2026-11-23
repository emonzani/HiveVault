/**
 * Models page of the console (plan §10, phase 7): local processes (start, stop, restart,
 * threads and schedule), remote endpoints (add, remove, test), live state of the dispatcher.
 * Changes are stored in the settings, so they survive a restart.
 */
import { lookup } from "node:dns/promises";
import { EXTRACT_POOL, LlamaEndpoint, LocalModelSupervisor, type ModelsRuntime } from "@cb/models";
import { isPrivateAddress, type EgressGuard, type ModelsConfig } from "@cb/shared";
import type { LocalModelSettings, RemoteEndpointSetting, Settings } from "./settings.ts";

export class ModelsAdminError extends Error {}

export class ModelsAdmin {
  constructor(
    private readonly runtime: ModelsRuntime,
    private readonly settings: Settings,
    private readonly egress: EgressGuard | null,
    private readonly apiKey?: string,
    /** Configuration of .env: needed to rebuild a .env endpoint at a new address. */
    private readonly cfg?: ModelsConfig,
  ) {}

  /** Applies the stored settings at startup: remote endpoints and local process settings. */
  async applyStored(): Promise<void> {
    for (const r of this.settings.get("models.remote")) this.attachRemote(r);
    for (const [id, url] of Object.entries(this.settings.get("models.overrides"))) this.replaceEnvEndpoint(id, url);
    const local = this.settings.get("models.local");
    if (this.runtime.supervisors.some((s) => s.spec.threads !== local.threads || s.spec.schedule !== local.schedule || s.spec.offHours !== local.offHours)) {
      await this.replaceSupervisors(local);
    }
  }

  snapshot() {
    const d = this.runtime.dispatcher.snapshot();
    return {
      endpoints: d.endpoints,
      queues: d.queues,
      local: this.runtime.supervisors.map((s) => ({ ...s.snapshot(), logTail: s.snapshot().logTail.slice(-40), threads: s.spec.threads, schedule: s.spec.schedule ?? "always", offHours: s.spec.offHours ?? "", model: s.spec.model.split(/[\\/]/).pop(), port: s.spec.port })),
      localSettings: this.settings.get("models.local"),
      remote: this.settings.get("models.remote"),
      overrides: this.settings.get("models.overrides"),
    };
  }

  private supervisor(kind: string): LocalModelSupervisor {
    const s = this.runtime.supervisors.find((x) => x.spec.kind === kind);
    if (!s) throw new ModelsAdminError("Processo locale non configurato (LOCAL_MODELS_ENABLED).");
    return s;
  }

  async local(kind: "embed" | "rerank", action: "start" | "stop" | "restart"): Promise<void> {
    const s = this.supervisor(kind);
    if (action !== "start") await s.stop();
    if (action !== "stop") s.start();
  }

  /** New threads or schedule: the processes start again with the new settings. */
  async setLocal(v: LocalModelSettings, by: string): Promise<void> {
    if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(v.offHours)) throw new ModelsAdminError("Fascia oraria non valida: usa HH:MM-HH:MM.");
    await this.settings.set("models.local", v, by);
    await this.replaceSupervisors(v);
  }

  private async replaceSupervisors(v: LocalModelSettings): Promise<void> {
    const list = this.runtime.supervisors;
    for (let i = 0; i < list.length; i++) {
      const old = list[i]!;
      await old.stop();
      const next = new LocalModelSupervisor({ ...old.spec, threads: v.threads, schedule: v.schedule, offHours: v.offHours });
      const id = `local-${old.spec.kind}`;
      next.on("status", (st) => {
        if (st === "running") void this.runtime.dispatcher.recheck(id);
      });
      next.start();
      list[i] = next;
    }
  }

  private attachRemote(r: RemoteEndpointSetting): void {
    if (this.runtime.dispatcher.snapshot().endpoints.some((e) => e.id === r.id)) return;
    // an endpoint added by an administrator: checkUrl found private addresses, and every
    // connection checks again the address it resolves (DNS rebinding, invariant 1)
    this.egress?.allowUrls([r.url], { privateOnly: true });
    const ep = new LlamaEndpoint({ id: r.id, kind: r.kind, origin: "remote", url: r.url, slots: r.kind === "embed" ? 4 : r.kind === "rerank" ? 2 : 1, ...(this.apiKey ? { apiKey: this.apiKey } : {}), ...(r.kind === "ocr" && this.cfg ? { ocrPrompt: this.cfg.ocr.prompt, timeoutMs: this.cfg.chat.requestTimeoutMs } : {}) });
    void this.runtime.dispatcher.addEndpoint(ep).catch(() => {});
  }

  async addRemote(kind: RemoteEndpointSetting["kind"], url: string, by: string): Promise<RemoteEndpointSetting> {
    const clean = await this.checkUrl(url);
    const list = this.settings.get("models.remote");
    if (list.some((r) => r.url === clean && r.kind === kind)) throw new ModelsAdminError("Endpoint già presente.");
    const n = list.filter((r) => r.kind === kind).length + 1;
    const r: RemoteEndpointSetting = { id: `console-${kind}-${n}-${Date.now().toString(36).slice(-4)}`, kind, url: clean };
    await this.settings.set("models.remote", [...list, r], by);
    this.attachRemote(r);
    return r;
  }

  /**
   * The remote endpoints of .env, rebuilt with their .env options at another address. The
   * dispatcher checks the model again; local processes and mocks are not remote endpoints.
   */
  private envEndpoint(id: string, url: string): LlamaEndpoint | null {
    const c = this.cfg;
    if (!c) return null;
    const key = c.apiKey ? { apiKey: c.apiKey } : {};
    if (id === "chat") {
      return new LlamaEndpoint({ id, kind: "chat", origin: "remote", url, slots: c.chat.parallelism, timeoutMs: c.chat.requestTimeoutMs, maxTokens: c.chat.maxTokens, temperature: c.chat.temperature, ...key });
    }
    if (/^remote-extract-\d+$/.test(id)) {
      return new LlamaEndpoint({ id, kind: "chat", origin: "remote", url, slots: c.chat.extractParallelism, timeoutMs: c.chat.requestTimeoutMs, maxTokens: c.chat.maxTokens, temperature: c.chat.temperature, ...key });
    }
    const m = /^remote-(embed|rerank|ocr)-\d+$/.exec(id);
    if (!m) return null;
    if (m[1] === "ocr") return new LlamaEndpoint({ id, kind: "ocr", origin: "remote", url, slots: 1, timeoutMs: c.chat.requestTimeoutMs, ocrPrompt: c.ocr.prompt, ...key });
    return new LlamaEndpoint({ id, kind: m[1] as "embed" | "rerank", origin: "remote", url, slots: m[1] === "embed" ? 4 : 2, ...key });
  }

  private replaceEnvEndpoint(id: string, url: string): void {
    const ep = this.envEndpoint(id, url);
    if (!ep || !this.runtime.dispatcher.snapshot().endpoints.some((e) => e.id === id)) return;
    this.egress?.allowUrls([url], { privateOnly: true });
    this.runtime.dispatcher.removeEndpoint(id);
    void this.runtime.dispatcher.addEndpoint(ep, id.startsWith("remote-extract-") ? { pool: EXTRACT_POOL } : {}).catch(() => {});
  }

  /** The address of .env for an endpoint id (chat, remote-embed-N, remote-rerank-N, remote-ocr-N). */
  private envUrl(id: string): string | undefined {
    const c = this.cfg;
    if (!c) return undefined;
    if (id === "chat") return c.chat.url;
    const x = /^remote-extract-(\d+)$/.exec(id);
    if (x) return c.chat.extractUrls[Number(x[1]) - 1];
    const m = /^remote-(embed|rerank|ocr)-(\d+)$/.exec(id);
    return m ? c[m[1] as "embed" | "rerank" | "ocr"].remoteUrls[Number(m[2]) - 1] : undefined;
  }

  /**
   * New address of a remote endpoint: one added from the console, or one of .env (the new
   * address is stored as an override; the address of .env again removes the override).
   */
  async updateRemote(id: string, url: string, by: string): Promise<RemoteEndpointSetting> {
    const list = this.settings.get("models.remote");
    const cur = list.find((r) => r.id === id);
    if (!cur) {
      const ep = this.runtime.dispatcher.snapshot().endpoints.find((e) => e.id === id);
      if (!ep || ep.origin !== "remote" || !this.envEndpoint(id, "http://x")) {
        throw new ModelsAdminError("Questo endpoint non si modifica: i processi locali si gestiscono nella sezione Processi locali.");
      }
      const clean = await this.checkUrl(url);
      const overrides = { ...this.settings.get("models.overrides") };
      if (clean === this.envUrl(id)?.replace(/\/+$/, "")) delete overrides[id];
      else overrides[id] = clean;
      // replace the whole object: Settings merges objects over their defaults, not over the old value
      await this.settings.set("models.overrides", overrides, by);
      this.replaceEnvEndpoint(id, clean);
      return { id, kind: ep.kind as RemoteEndpointSetting["kind"], url: clean };
    }
    const clean = await this.checkUrl(url);
    if (list.some((r) => r.id !== id && r.url === clean && r.kind === cur.kind)) throw new ModelsAdminError("Endpoint già presente.");
    const next = { ...cur, url: clean };
    await this.settings.set("models.remote", list.map((r) => (r.id === id ? next : r)), by);
    this.runtime.dispatcher.removeEndpoint(id);
    this.attachRemote(next);
    return next;
  }

  /** http(s) only, and every address of the host in the company network (invariant 1). */
  private async checkUrl(url: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ModelsAdminError("Indirizzo non valido.");
    }
    if (!/^https?:$/.test(u.protocol)) throw new ModelsAdminError("Solo indirizzi http o https.");
    // invariant 1: the text of the documents goes to model servers of the company network only
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let addrs: { address: string }[];
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      throw new ModelsAdminError(`Host «${host}» non trovato.`);
    }
    if (!addrs.length || addrs.some((a) => !isPrivateAddress(a.address))) {
      throw new ModelsAdminError("L'endpoint deve essere nella rete aziendale (indirizzo privato): i documenti non escono dalla rete.");
    }
    return u.toString().replace(/\/+$/, "");
  }

  async removeRemote(id: string, by: string): Promise<void> {
    const list = this.settings.get("models.remote");
    if (!list.some((r) => r.id === id)) throw new ModelsAdminError("Solo gli endpoint aggiunti dalla console si rimuovono qui; gli altri sono nel file .env.");
    await this.settings.set("models.remote", list.filter((r) => r.id !== id), by);
    this.runtime.dispatcher.removeEndpoint(id);
  }

  test(id: string) {
    return this.runtime.dispatcher.testEndpoint(id);
  }
}
