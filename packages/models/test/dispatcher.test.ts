import { describe, expect, it } from "vitest";
import { ModelDispatcher, MockEndpoint, mockEmbedding, NoEndpointError } from "../src/index.ts";

const EXPECTED = { embed: { model: "mock-embed-hash-v1", dimensions: 16 } };

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

describe("mock embeddings", () => {
  it("are deterministic and lexically meaningful", () => {
    const a = mockEmbedding("contratto SaaS con Acme per 500 posti", 256);
    const b = mockEmbedding("Acme rinnova il contratto SaaS", 256);
    const c = mockEmbedding("ricetta della torta di mele", 256);
    expect(mockEmbedding("contratto SaaS con Acme per 500 posti", 256)).toEqual(a);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});

describe("ModelDispatcher", () => {
  it("serves higher priority first, and aging promotes old jobs", async () => {
    const ep = new MockEndpoint({ kind: "chat", slots: 1, latencyMs: 20 });
    const d = new ModelDispatcher({ expected: {}, agingMs: 0 });
    await d.addEndpoint(ep);
    const order: string[] = [];
    const call = (name: string, priority: 0 | 1 | 2) =>
      d.chat({ messages: [{ role: "user", content: name }] }, { priority }).then(() => order.push(name));
    const first = call("busy", 2); // takes the only slot
    const jobs = [call("bg", 2), call("ingest", 1), call("interactive", 0)];
    await Promise.all([first, ...jobs]);
    expect(order).toEqual(["busy", "interactive", "ingest", "bg"]);
    d.stop();
  });

  it("aging moves a long-waiting background job ahead", async () => {
    const ep = new MockEndpoint({ kind: "chat", slots: 1, latencyMs: 60 });
    const d = new ModelDispatcher({ expected: {}, agingMs: 25 });
    await d.addEndpoint(ep);
    const order: string[] = [];
    const call = (name: string, priority: 0 | 1 | 2) =>
      d.chat({ messages: [{ role: "user", content: name }] }, { priority }).then(() => order.push(name));
    const first = call("busy", 1);
    const old = call("old-bg", 2); // waits 60 ms -> aged by 2 levels -> effective 0
    await new Promise((r) => setTimeout(r, 55));
    const fresh = call("fresh-ingest", 1);
    await Promise.all([first, old, fresh]);
    expect(order).toEqual(["busy", "old-bg", "fresh-ingest"]);
    d.stop();
  });

  it("splits batches by measured speed across endpoints (work pulling)", async () => {
    const fast = new MockEndpoint({ kind: "embed", id: "fast", slots: 1, perItemMs: 10, dimensions: 16 });
    const slow = new MockEndpoint({ kind: "embed", id: "slow", slots: 1, perItemMs: 50, dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED });
    await d.addEndpoint(fast);
    await d.addEndpoint(slow);
    const batches = Array.from({ length: 20 }, (_, i) => Array.from({ length: 4 }, (_, j) => `t${i}-${j}`));
    await Promise.all(batches.map((b) => d.embed(b, { priority: 2 })));
    expect(fast.calls).toBeGreaterThan(slow.calls * 2);
    d.stop();
  });

  it("sends interactive jobs to the lowest-latency endpoint", async () => {
    const near = new MockEndpoint({ kind: "embed", id: "near", slots: 4, latencyMs: 2, dimensions: 16 });
    const far = new MockEndpoint({ kind: "embed", id: "far", slots: 4, latencyMs: 30, dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED });
    await d.addEndpoint(near);
    await d.addEndpoint(far);
    // warm up: measure both
    await Promise.all([d.embed(["a"], { priority: 2 }), d.embed(["b"], { priority: 2 })]);
    await d.embed(["warm"], { priority: 1 });
    const before = { near: near.calls, far: far.calls };
    for (let i = 0; i < 5; i++) await d.embed([`q${i}`], { priority: 0 });
    expect(near.calls - before.near).toBe(5);
    expect(far.calls - before.far).toBe(0);
    d.stop();
  });

  it("keeps a slot free for interactive jobs while a backfill runs", async () => {
    const ep = new MockEndpoint({ kind: "embed", id: "cpu", slots: 4, latencyMs: 200, dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED }); // default: 1 embed slot reserved
    await d.addEndpoint(ep);
    const backfill = Array.from({ length: 12 }, (_, i) => d.embed([`b${i}`], { priority: 2 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(d.snapshot().endpoints[0]!.inflight).toBe(3); // the 4th slot stays free
    const t = performance.now();
    await d.embed(["query"], { priority: 0 });
    expect(performance.now() - t).toBeLessThan(300); // no wait behind a batch
    await Promise.all(backfill);
    d.stop();
  });

  it("splits background batches into short requests and keeps the order", async () => {
    const ep = new MockEndpoint({ kind: "embed", id: "e", slots: 4, dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED, backgroundItemsPerRequest: 2 });
    await d.addEndpoint(ep);
    const texts = Array.from({ length: 9 }, (_, i) => `testo numero ${i}`);
    const r = await d.embed(texts, { priority: 2 });
    expect(ep.calls).toBe(5);
    expect(r.vectors).toEqual(texts.map((t) => mockEmbedding(t, 16)));
    await d.embed(["a", "b", "c"], { priority: 0 }); // interactive: one request
    expect(ep.calls).toBe(6);
    d.stop();
  });

  it("a 1-slot endpoint reserves nothing, so background work still runs", async () => {
    const ep = new MockEndpoint({ kind: "embed", id: "one", slots: 1, latencyMs: 5, dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED });
    await d.addEndpoint(ep);
    await expect(d.embed(["x"], { priority: 2 })).resolves.toBeTruthy();
    d.stop();
  });

  it("rejects an embedding endpoint with a different model", async () => {
    const wrong = new MockEndpoint({ kind: "embed", id: "wrong", modelName: "bge-m3-q8_0", dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED, offlineMode: "queue" });
    expect(await d.addEndpoint(wrong)).toBe("mismatch");
    expect(d.snapshot().endpoints[0]?.reason).toMatch(/different from the expected/);
    d.stop();
  });

  it("rejects an embedding endpoint with too few dimensions", async () => {
    const small = new MockEndpoint({ kind: "embed", id: "small", dimensions: 8 });
    const d = new ModelDispatcher({ expected: EXPECTED });
    expect(await d.addEndpoint(small)).toBe("mismatch");
    d.stop();
  });

  it("truncates vectors to EMBED_DIMENSIONS and renormalizes", async () => {
    const big = new MockEndpoint({ kind: "embed", id: "big", dimensions: 64 });
    const d = new ModelDispatcher({ expected: { embed: { model: "mock-embed-hash-v1", dimensions: 16 } } });
    await d.addEndpoint(big);
    const r = await d.embed(["hello world"]);
    expect(r.vectors[0]).toHaveLength(16);
    expect(cosine(r.vectors[0]!, r.vectors[0]!)).toBeCloseTo(1, 6);
    d.stop();
  });

  it("never uses the mock fallback for embeddings while a real endpoint exists", async () => {
    const real = new MockEndpoint({ kind: "embed", id: "real", dimensions: 16 });
    real.up = false;
    const fallback = new MockEndpoint({ kind: "embed", id: "fallback", modelName: "other", dimensions: 16 });
    const d = new ModelDispatcher({ expected: EXPECTED, offlineMode: "mock", healthIntervalMs: 20 }).start();
    await d.addEndpoint(real);
    await d.addEndpoint(fallback, { fallback: true });
    const p = d.embed(["waits for the real endpoint"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fallback.calls).toBe(0);
    real.up = true; // the periodic health check brings it back
    const r = await p;
    expect(r.model).toBe("mock-embed-hash-v1");
    expect(fallback.calls).toBe(0);
    d.stop();
  });

  it("uses the chat fallback in mock mode when the chat endpoint is down", async () => {
    const real = new MockEndpoint({ kind: "chat", id: "real-chat" });
    real.up = false;
    const fb = new MockEndpoint({ kind: "chat", id: "mock-chat" });
    const d = new ModelDispatcher({ expected: {}, offlineMode: "mock" });
    await d.addEndpoint(real);
    await d.addEndpoint(fb, { fallback: true });
    const r = await d.chat({ messages: [{ role: "user", content: "ciao" }] });
    expect(r.content).toContain("[mock]");
    d.stop();
  });

  it("fails fast in queue mode when a kind has no endpoint at all", async () => {
    const d = new ModelDispatcher({ expected: {}, offlineMode: "queue" });
    await expect(d.rerank("q", ["a"])).rejects.toBeInstanceOf(NoEndpointError);
    d.stop();
  });

  it("retries on another endpoint after a failure", async () => {
    const bad = new MockEndpoint({ kind: "embed", id: "bad", dimensions: 16, failRate: 1 });
    const good = new MockEndpoint({ kind: "embed", id: "good", dimensions: 16, latencyMs: 5 });
    const d = new ModelDispatcher({ expected: EXPECTED });
    await d.addEndpoint(bad);
    await d.addEndpoint(good);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => d.embed([`x${i}`], { priority: 2 })));
    expect(results).toHaveLength(6);
    expect(d.snapshot().endpoints.find((e) => e.id === "bad")?.status).toBe("down");
    d.stop();
  });
});

describe("ModelDispatcher pools (M4)", () => {
  const served = (d: ModelDispatcher, pool?: string) =>
    d.chat({ messages: [{ role: "user", content: "x" }] }, pool ? { pool } : {}).then((r) => r.content);
  const named = (id: string, slots = 1, latencyMs = 0) => new MockEndpoint({ kind: "chat", id, slots, latencyMs, script: () => ({ content: id }) });

  it("without pool endpoints a pool job goes to the main model, as before", async () => {
    const d = new ModelDispatcher({ expected: {} });
    await d.addEndpoint(named("main"));
    expect(await served(d, "extract")).toBe("main");
    expect(d.busy("chat", "extract")).toBe(false);
    d.stop();
  });

  it("pool jobs go to the pool, other jobs never do; a down pool falls back to the main model", async () => {
    const d = new ModelDispatcher({ expected: {} });
    const small = named("small");
    await d.addEndpoint(named("main"));
    await d.addEndpoint(small, { pool: "extract" });
    expect(await served(d, "extract")).toBe("small");
    expect(await served(d)).toBe("main");
    expect(d.snapshot().endpoints.find((e) => e.id === "small")?.pool).toBe("extract");
    small.up = false;
    await d.recheck("small");
    expect(await served(d, "extract")).toBe("main");
    d.stop();
  });

  it("a busy pool does not hold the questions, and busy() looks at the lane of the job", async () => {
    const d = new ModelDispatcher({ expected: {} });
    await d.addEndpoint(named("main", 1, 5));
    await d.addEndpoint(named("small", 1, 80), { pool: "extract" });
    const slow = served(d, "extract");
    const queued = served(d, "extract");
    expect(d.busy("chat", "extract")).toBe(true);
    expect(d.busy("chat")).toBe(false);
    // the question is served while two extractions wait for the small model
    expect(await served(d)).toBe("main");
    expect(await Promise.all([slow, queued])).toEqual(["small", "small"]);
    d.stop();
  });
});
