import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalModelSupervisor, buildLlamaArgs, inWindow, LlamaEndpoint, ModelDispatcher } from "../src/index.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-llama.mjs");
let port = 18900 + Math.floor(Math.random() * 50);
const sups: LocalModelSupervisor[] = [];

function makeSupervisor(extra: Partial<ConstructorParameters<typeof LocalModelSupervisor>[0]> = {}) {
  const s = new LocalModelSupervisor({
    name: "test-embed",
    kind: "embed",
    bin: process.execPath,
    prefixArgs: [FAKE],
    model: "Fake-Embed-Q8_0.gguf",
    port: port++,
    threads: 2,
    healthIntervalMs: 100,
    startTimeoutMs: 5000,
    ...extra,
  });
  sups.push(s);
  return s;
}

async function waitFor(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timeout");
}

afterEach(async () => {
  await Promise.all(sups.splice(0).map((s) => s.stop()));
  delete process.env.FAKE_EXIT_AFTER_MS;
});

describe("buildLlamaArgs / inWindow", () => {
  it("forces CPU, localhost and the thread limit", () => {
    const a = buildLlamaArgs({ name: "e", kind: "embed", bin: "x", model: "m.gguf", port: 1, threads: 6 });
    expect(a).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--threads", "6", "--n-gpu-layers", "0", "--embedding"]));
  });
  it("handles windows across midnight", () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 0);
    expect(inWindow("19:00-07:00", at(23))).toBe(true);
    expect(inWindow("19:00-07:00", at(3))).toBe(true);
    expect(inWindow("19:00-07:00", at(12))).toBe(false);
    expect(inWindow("09:00-17:00", at(12))).toBe(true);
  });
});

describe("LocalModelSupervisor", () => {
  it("starts the process and reports running", async () => {
    const s = makeSupervisor();
    s.start();
    await waitFor(() => s.snapshot().status === "running");
    expect(s.snapshot().pid).toBeGreaterThan(0);
  });

  it("restarts the process after a crash", async () => {
    process.env.FAKE_EXIT_AFTER_MS = "400";
    const s = makeSupervisor();
    s.start();
    await waitFor(() => s.snapshot().status === "running");
    delete process.env.FAKE_EXIT_AFTER_MS; // the restarted process stays up
    await waitFor(() => s.snapshot().restarts >= 1 && s.snapshot().status === "running");
    expect(s.snapshot().lastError).toMatch(/exited/);
  });

  it("on-demand: ensureRunning starts it, and the dispatcher can use it", async () => {
    const s = makeSupervisor({ schedule: "on-demand" });
    await s.ensureRunning();
    const d = new ModelDispatcher({ expected: { embed: { model: "Fake-Embed-Q8_0.gguf", dimensions: 8 } } });
    const status = await d.addEndpoint(new LlamaEndpoint({ id: "local", kind: "embed", origin: "local", url: s.url }));
    expect(status).toBe("up");
    const r = await d.embed(["uno", "due"]);
    expect(r.vectors).toHaveLength(2);
    expect(r.model).toBe("fake-embed-q8_0");
    d.stop();
  });

  it("stop() terminates the process", async () => {
    const s = makeSupervisor();
    s.start();
    await waitFor(() => s.snapshot().status === "running");
    await s.stop();
    expect(s.snapshot().status).toBe("stopped");
    const alive = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    expect(alive).toBe(false);
  });
});
