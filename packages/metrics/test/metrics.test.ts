import { afterAll, describe, expect, it } from "vitest";
import type { Sql } from "@cb/db";
import { setupTestDb } from "@cb/db/testing";
import { MetricsRegistry, ulid } from "@cb/shared";
import { MetricsService, MetricsStore, quantile } from "../src/index.ts";

const sql: Sql | undefined = await setupTestDb();
const run = ulid().slice(-6).toLowerCase();
afterAll(async () => {
  await sql?.end();
});
const db = () => (sql ? it : it.skip);

describe("registry", () => {
  it("counts, keeps the last gauge, buckets histograms, drains per window", () => {
    const r = new MetricsRegistry();
    r.inc("req", { route: "/a" });
    r.inc("req", { route: "/a" }, 2);
    r.set("queue", 5);
    r.set("queue", 7);
    for (const v of [3, 40, 40, 900]) r.observe("lat", v, { b: "x" });
    const w1 = r.drain();
    expect(w1.find((s) => s.name === "req")).toMatchObject({ kind: "counter", sum: 3, count: 2 });
    expect(w1.find((s) => s.name === "queue")).toMatchObject({ kind: "gauge", last: 7, min: 5, max: 7 });
    const lat = w1.find((s) => s.name === "lat")!;
    expect(lat).toMatchObject({ count: 4, min: 3, max: 900 });
    expect(lat.buckets).toMatchObject({ "5": 1, "50": 2, "1000": 1 });
    // next window: counters start again, the gauge is still there
    const w2 = r.drain();
    expect(w2.map((s) => s.name)).toEqual(["queue"]);
    const text = r.prometheus();
    expect(text).toContain('cb_req_total{route="/a"} 3');
    expect(text).toContain("cb_queue 7");
    expect(text).toContain('cb_lat_bucket{b="x",le="50"} 3');
    expect(text).toContain('cb_lat_count{b="x"} 4');
  });

  it("estimates quantiles from buckets", () => {
    expect(quantile({ "10": 50, "100": 50, "+Inf": 0 }, 0.5)).toBe(10);
    expect(quantile({ "10": 50, "100": 50, "+Inf": 0 }, 0.95)).toBeCloseTo(91, 0);
    expect(quantile({}, 0.5)).toBeNull();
  });
});

describe("store", () => {
  db()("writes minutes, adds samples of several processes, rolls up, queries by group and percentile", async () => {
    const store = new MetricsStore(sql!);
    const name = `t_${run}`;
    const base = new Date(Date.UTC(2026, 9, 28, 10, 0));
    const r1 = new MetricsRegistry();
    const r2 = new MetricsRegistry();
    for (let m = 0; m < 120; m++) {
      const t = new Date(base.getTime() + m * 60_000);
      r1.inc(`${name}_req`, { route: "/a" }, 2);
      r2.inc(`${name}_req`, { route: "/b" }, 1);
      r1.set(`${name}_queue`, m, { q: "x" });
      r2.set(`${name}_queue`, 10, { q: "y" });
      r1.observe(`${name}_ms`, m < 60 ? 20 : 200);
      await store.write(t, [...r1.drain(), ...r2.drain()]);
    }
    // a second process writes into the same minute: values add up
    const extra = new MetricsRegistry();
    extra.inc(`${name}_req`, { route: "/a" }, 3);
    await store.write(base, extra.drain());

    const from = base;
    const to = new Date(base.getTime() + 120 * 60_000);
    const rate = await store.query({ name: `${name}_req`, agg: "rate", from, to, groupBy: ["route"], points: 120 });
    expect(rate.table).toBe("1m");
    expect(rate.series.map((s) => s.labels.route)).toEqual(["/a", "/b"]);
    expect(rate.series[0]!.points[0]![1]).toBe(5);
    expect(rate.series[0]!.points[1]![1]).toBe(2);
    const total = await store.query({ name: `${name}_req`, agg: "sum", from, to, points: 1 });
    expect(total.series[0]!.points.reduce((a, p) => a + p[1], 0)).toBe(120 * 3 + 3);

    // gauges of two series add up; the last value of the step
    const q = await store.query({ name: `${name}_queue`, agg: "last", from, to, points: 2 });
    expect(q.series[0]!.points.at(-1)![1]).toBe(119 + 10);
    const onlyX = await store.query({ name: `${name}_queue`, agg: "max", match: { q: "x" }, from, to, points: 1 });
    expect(onlyX.series[0]!.points[0]![1]).toBe(119);

    const p95 = await store.query({ name: `${name}_ms`, agg: "p95", from, to, points: 2 });
    expect(p95.series[0]!.points[0]![1]).toBeLessThanOrEqual(25);
    expect(p95.series[0]!.points[1]![1]).toBeGreaterThan(100);

    // hourly rollup: same totals, histograms kept; a longer range reads the hourly table
    expect(await store.rollup("1h", from, to)).toBeGreaterThan(0);
    expect(await store.rollup("1h", from, to)).toBeGreaterThan(0); // idempotent
    const long = await store.query({ name: `${name}_req`, agg: "sum", from: new Date(base.getTime() - 3 * 86_400_000), to, points: 100 });
    expect(long.table).toBe("1h");
    expect(long.series[0]!.points.reduce((a, p) => a + p[1], 0)).toBe(120 * 3 + 3);
    const longP = await store.query({ name: `${name}_ms`, agg: "p50", from: new Date(base.getTime() - 3 * 86_400_000), to, points: 100 });
    expect(longP.series[0]!.points.length).toBe(2);

    const cat = await store.catalog();
    expect(cat.find((c) => c.name === `${name}_req`)).toMatchObject({ kind: "counter", labels: { route: ["/a", "/b"] } });
  });

  db()("one leader runs the collectors; every process writes its counters", async () => {
    const r1 = new MetricsRegistry();
    const r2 = new MetricsRegistry();
    // a lock of their own: the servers of other test files elect their leader on the same database
    const lockKey = 7_260_400_000 + Math.floor(Math.random() * 1_000_000);
    const a = new MetricsService(sql!, { registry: r1, lockKey });
    const b = new MetricsService(sql!, { registry: r2, lockKey });
    let calls = 0;
    const name = `l_${run}`;
    a.addCollector("c", (set) => void (calls++, set(`${name}_g`, 1)));
    b.addCollector("c", (set) => void (calls++, set(`${name}_g`, 1)));
    r1.inc(`${name}_c`);
    r2.inc(`${name}_c`);
    const now = new Date();
    await a.tick(now);
    await b.tick(now);
    expect(calls).toBe(1);
    expect([a.isLeader, b.isLeader].filter(Boolean)).toHaveLength(1);
    const res = await a.store.query({ name: `${name}_c`, agg: "sum", from: new Date(now.getTime() - 3_600_000), to: new Date(now.getTime() + 60_000), points: 1 });
    expect(res.series[0]!.points[0]![1]).toBe(2);
    await a.stop();
    await b.stop();
  });
});
