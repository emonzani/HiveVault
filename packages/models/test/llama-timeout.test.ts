import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { LlamaEndpoint } from "../src/index.ts";

// A chat model that sends its headers only when the whole answer is ready (non-streaming
// llama-server with a long prompt). The global fetch of Node closes such a request after its
// own headersTimeout (300 s by default), whatever the AbortSignal of the caller says.
describe("LlamaEndpoint long requests", () => {
  let server: http.Server;
  let url = "";
  const previous = getGlobalDispatcher();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }));
      }, 2500);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The default headersTimeout of 300 s, scaled down to keep the test short.
    setGlobalDispatcher(new Agent({ headersTimeout: 1000, bodyTimeout: 1000 }));
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("waits up to its own timeout, not the HTTP client default", { timeout: 10_000 }, async () => {
    const ep = new LlamaEndpoint({ id: "chat", kind: "chat", origin: "remote", url, timeoutMs: 5000 });
    const out = await ep.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(out.content).toBe("ok");
  });

  it("still stops at its own timeout", async () => {
    const ep = new LlamaEndpoint({ id: "chat", kind: "chat", origin: "remote", url, timeoutMs: 1500 });
    await expect(ep.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
  });
});
