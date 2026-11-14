/**
 * Metrics loop of a server process: every minute it runs the collectors (gauges such as queue
 * lengths, database size, host CPU), drains the in-process registry and writes the minute.
 *
 * Every process writes its own counters and histograms (they add up in the same row); only the
 * leader (Postgres advisory lock) runs the collectors, the rollups and the partition upkeep,
 * so gauges are not counted twice.
 */
import type { Sql } from "@cb/db";
import { createLogger, metrics as registry, type MetricsRegistry } from "@cb/shared";
import { MetricsStore } from "./store.ts";

const log = createLogger("metrics");
const LOCK = 7_260_331_001;

/** A collector sets gauges (or adds counters) on the registry. Errors are logged, not thrown. */
export type Collector = (set: (name: string, value: number, labels?: Record<string, string>) => void) => Promise<void> | void;

export interface MetricsServiceOptions {
  intervalMs?: number;
  registry?: MetricsRegistry;
  minuteDays?: number;
  hourDays?: number;
  /** Advisory lock of the leader election (default: the one of every server of this database). */
  lockKey?: number;
}

export class MetricsService {
  readonly store: MetricsStore;
  private readonly registry: MetricsRegistry;
  private collectors = new Map<string, { fn: Collector; everyMs: number; lastAt: number }>();
  private timer: NodeJS.Timeout | undefined;
  private leaderConn: Awaited<ReturnType<Sql["reserve"]>> | null = null;
  private leader = false;
  private lastRollupDay = 0;
  private running: Promise<void> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly o: MetricsServiceOptions = {},
  ) {
    this.store = new MetricsStore(sql, { minuteDays: o.minuteDays ?? 14, hourDays: o.hourDays ?? 400 });
    this.registry = o.registry ?? registry;
  }

  /** Registers a collector; `everyMs` lets expensive ones run less often (default every tick). */
  addCollector(name: string, fn: Collector, everyMs = 0): this {
    this.collectors.set(name, { fn, everyMs, lastAt: 0 });
    return this;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.store.ensurePartitions();
    const interval = this.o.intervalMs ?? 60_000;
    // first tick at the next minute boundary, then every interval
    const delay = interval === 60_000 ? 60_000 - (Date.now() % 60_000) + 1500 : interval;
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), interval);
      this.timer.unref();
    }, delay);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    await this.running;
    await this.tick(); // the last partial minute
    if (this.leaderConn) {
      try {
        await this.leaderConn`select pg_advisory_unlock(${this.o.lockKey ?? LOCK})`;
      } catch {
        /* connection gone */
      }
      this.leaderConn.release();
      this.leaderConn = null;
    }
  }

  private async ensureLeader(): Promise<boolean> {
    try {
      if (!this.leaderConn) {
        this.leaderConn = await this.sql.reserve();
        const [r] = await this.leaderConn<{ ok: boolean }[]>`select pg_try_advisory_lock(${this.o.lockKey ?? LOCK}) as ok`;
        this.leader = !!r?.ok;
        if (!this.leader) {
          this.leaderConn.release();
          this.leaderConn = null;
        }
      } else {
        await this.leaderConn`select 1`;
      }
    } catch {
      this.leader = false;
      this.leaderConn = null;
    }
    return this.leader;
  }

  /** One minute: collectors (leader), drain, write, rollups (leader). */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        if (await this.ensureLeader()) {
          for (const [name, c] of this.collectors) {
            if (c.everyMs && now.getTime() - c.lastAt < c.everyMs) continue;
            c.lastAt = now.getTime();
            try {
              await c.fn((n, v, l) => this.registry.set(n, v, l ?? {}));
            } catch (e) {
              log.warn("collector failed", { collector: name, error: String((e as Error).message ?? e) });
            }
          }
        }
        // the samples belong to the minute that just ended
        const bucket = new Date(Math.floor((now.getTime() - 30_000) / 60_000) * 60_000);
        await this.store.write(bucket, this.registry.drain());
        if (this.leader) {
          const h = 3_600_000;
          const hourStart = Math.floor(now.getTime() / h) * h;
          await this.store.rollup("1h", new Date(hourStart - h), new Date(hourStart + h));
          const d = 86_400_000;
          const dayStart = Math.floor(now.getTime() / d) * d;
          if (now.getTime() - this.lastRollupDay > 10 * 60_000) {
            await this.store.rollup("1d", new Date(dayStart - d), new Date(dayStart + d));
            this.lastRollupDay = now.getTime();
          }
          if (now.getUTCMinutes() === 5) await this.store.ensurePartitions(now);
        }
      } catch (e) {
        log.warn("metrics tick failed", { error: String((e as Error).message ?? e) });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
