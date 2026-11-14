import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { setPriority, constants as osConstants } from "node:os";
import { createLogger } from "@cb/shared";
import type { LocalSchedule } from "@cb/shared";

/**
 * Supervises one local llama-server process (local mode, D10).
 *
 * - Listens on 127.0.0.1 only.
 * - CPU only (`--n-gpu-layers 0`), thread limit, low process priority: Postgres and
 *   interactive search stay responsive while embeddings run.
 * - Health check every `healthIntervalMs`; restart with exponential backoff when the
 *   process exits or stops answering.
 * - Schedule: always, off-hours (runs only in the configured window) or on-demand
 *   (started by `ensureRunning()`, stopped after `idleStopMs` without use).
 */

export type ProcessStatus = "stopped" | "starting" | "running" | "unhealthy" | "backoff" | "disabled";

export interface LocalProcessSpec {
  name: string;
  kind: "embed" | "rerank";
  bin: string;
  model: string;
  port: number;
  threads: number;
  /** Slots (-np) and context (-c). */
  parallel?: number;
  context?: number;
  /** Embedding pooling: Qwen3-Embedding uses "last", nomic/bge use "mean"/"cls". */
  pooling?: string;
  schedule?: LocalSchedule;
  offHours?: string;
  /** Arguments placed before the llama-server arguments (tests use `node fake-server.mjs`). */
  prefixArgs?: string[];
  extraArgs?: string[];
  healthIntervalMs?: number;
  startTimeoutMs?: number;
  idleStopMs?: number;
}

export interface SupervisorSnapshot {
  name: string;
  kind: string;
  status: ProcessStatus;
  pid: number | undefined;
  url: string;
  restarts: number;
  lastError: string | undefined;
  startedAt: number | undefined;
  logTail: string[];
}

const LOG_TAIL = 200;

/** "19:00-07:00" -> true when `now` is inside the window (the window can cross midnight). */
export function inWindow(window: string, now = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return true;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const t = now.getHours() * 60 + now.getMinutes();
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

export function buildLlamaArgs(spec: LocalProcessSpec): string[] {
  const args = [
    ...(spec.prefixArgs ?? []),
    "-m", spec.model,
    "--host", "127.0.0.1",
    "--port", String(spec.port),
    "--threads", String(spec.threads),
    "--n-gpu-layers", "0",
    "-np", String(spec.parallel ?? (spec.kind === "embed" ? 4 : 2)),
    "-c", String(spec.context ?? (spec.kind === "embed" ? 8192 : 4096)),
  ];
  if (spec.kind === "embed") {
    args.push("--embedding", "--pooling", spec.pooling ?? "last", "-b", "2048", "-ub", "2048");
  } else {
    // a rerank pair (query + document) must fit one physical batch: the default is 512 tokens
    args.push("--reranking", "-b", "2048", "-ub", "2048");
  }
  return [...args, ...(spec.extraArgs ?? [])];
}

export class LocalModelSupervisor extends EventEmitter {
  readonly url: string;
  private child: ChildProcess | undefined;
  private status: ProcessStatus = "stopped";
  private restarts = 0;
  private backoffMs = 1000;
  private lastError: string | undefined;
  private startedAt: number | undefined;
  private lastUse = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private wanted = false;
  private failedChecks = 0;
  private readonly tail: string[] = [];
  private readonly log;

  constructor(readonly spec: LocalProcessSpec) {
    super();
    this.url = `http://127.0.0.1:${spec.port}`;
    this.log = createLogger(`models.local.${spec.name}`);
  }

  snapshot(): SupervisorSnapshot {
    return {
      name: this.spec.name,
      kind: this.spec.kind,
      status: this.status,
      pid: this.child?.pid,
      url: this.url,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
      logTail: [...this.tail],
    };
  }

  /** Starts supervision. Depending on the schedule the process starts now or later. */
  start(): void {
    this.wanted = true;
    this.timer ??= setInterval(() => void this.tick(), this.spec.healthIntervalMs ?? 10_000);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stops supervision and the process. */
  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.killChild();
    this.setStatus("stopped");
  }

  /** For on-demand mode: start (if needed) and wait until healthy. Marks the process as used. */
  async ensureRunning(timeoutMs = this.spec.startTimeoutMs ?? 120_000): Promise<void> {
    this.lastUse = Date.now();
    if (this.status === "running") return;
    if (!this.child) this.spawnChild();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthy()) {
        this.setStatus("running");
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${this.spec.name} did not become healthy within ${timeoutMs} ms`);
  }

  touch(): void {
    this.lastUse = Date.now();
  }

  private shouldRun(): boolean {
    if (!this.wanted) return false;
    switch (this.spec.schedule ?? "always") {
      case "always":
        return true;
      case "off-hours":
        return inWindow(this.spec.offHours ?? "19:00-07:00");
      case "on-demand":
        return Date.now() - this.lastUse < (this.spec.idleStopMs ?? 10 * 60 * 1000);
    }
  }

  private async tick(): Promise<void> {
    const run = this.shouldRun();
    if (!run) {
      if (this.child) {
        this.log.info("schedule: stopping");
        await this.killChild();
      }
      this.setStatus(this.wanted ? "disabled" : "stopped");
      return;
    }
    if (!this.child) {
      if (this.status === "backoff") return; // restart timer pending
      this.spawnChild();
      return;
    }
    if (await this.healthy()) {
      this.failedChecks = 0;
      if (this.status !== "running") {
        this.backoffMs = 1000;
        this.setStatus("running");
      }
      return;
    }
    // Starting processes get time to load the model before they count as unhealthy.
    const graceMs = this.spec.startTimeoutMs ?? 120_000;
    if (this.status === "starting" && Date.now() - (this.startedAt ?? 0) < graceMs) return;
    this.failedChecks++;
    this.setStatus("unhealthy");
    if (this.failedChecks >= 3) {
      this.lastError = "health check failed 3 times";
      this.log.warn("restarting unhealthy process");
      await this.killChild();
      this.scheduleRestart();
    }
  }

  private async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  private spawnChild(): void {
    const args = buildLlamaArgs(this.spec);
    this.log.info("starting", { bin: this.spec.bin, port: this.spec.port, threads: this.spec.threads });
    const child = spawn(this.spec.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.startedAt = Date.now();
    this.failedChecks = 0;
    this.setStatus("starting");
    if (child.pid) {
      try {
        // Windows maps this to BELOW_NORMAL_PRIORITY_CLASS, POSIX to nice 10.
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* not permitted: keep the default priority */
      }
    }
    const onData = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        this.tail.push(line);
        if (this.tail.length > LOG_TAIL) this.tail.shift();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      this.lastError = err.message;
      this.log.error("spawn failed", { error: err.message });
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // an old process we killed on purpose
      this.child = undefined;
      this.lastError = `process exited (code ${code ?? "-"}, signal ${signal ?? "-"})`;
      this.log.warn("process exited", { code, signal });
      if (this.wanted && this.shouldRun()) this.scheduleRestart();
      else this.setStatus("stopped");
    });
  }

  private scheduleRestart(): void {
    this.setStatus("backoff");
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.restarts++;
    setTimeout(() => {
      if (!this.wanted || this.child) return;
      this.status = "stopped";
      void this.tick();
    }, delay).unref?.();
  }

  private killChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private setStatus(s: ProcessStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit("status", s);
  }
}
