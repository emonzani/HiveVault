import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressGuard, isPrivateAddress } from "../src/index.ts";

const blocked: string[] = [];
const guard = new EgressGuard({ allow: ["db.interno.example"], onBlocked: (e) => blocked.push(`${e.host}:${e.port}`) });
let server: http.Server;
let port = 0;
beforeAll(async () => {
  guard.install();
  server = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  guard.uninstall();
  await new Promise((r) => server.close(r));
});

describe("EgressGuard", () => {
  it("lets loopback through", async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("ok");
  });

  it("blocks any other host, for fetch and for raw sockets, and reports it", async () => {
    const err = await fetch("http://203.0.113.7:80/").catch((e) => e);
    expect(String(err.cause?.code ?? err.code)).toBe("EGRESS_BLOCKED");
    const sock = await new Promise<NodeJS.ErrnoException>((res) => {
      const s = new net.Socket();
      s.on("error", res);
      s.connect(443, "api.cloud-agent.test");
    });
    expect(sock.code).toBe("EGRESS_BLOCKED");
    expect(blocked).toEqual(expect.arrayContaining(["203.0.113.7:80", "api.cloud-agent.test:443"]));
  });

  it("allowFor opens a host only inside its scope", async () => {
    // the connection is attempted (and fails on DNS), so the guard let it through
    const inside = await guard.allowFor(["nonexistent.invalid"], () => fetch("http://nonexistent.invalid/").catch((e) => e));
    expect(String(inside.cause?.code ?? "")).not.toBe("EGRESS_BLOCKED");
    const outside = await fetch("http://nonexistent.invalid/").catch((e) => e);
    expect(String(outside.cause?.code)).toBe("EGRESS_BLOCKED");
  });

  it("publicOnly checks the address the connection resolves (DNS rebinding)", async () => {
    // a server no earlier test connected to: fetch would reuse an open connection
    const other = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((res) => other.listen(0, "127.0.0.1", () => res()));
    const p2 = (other.address() as { port: number }).port;
    try {
      // "localhost" stands for a name that passed the first check and now resolves to the LAN
      const named = await guard.allowFor(["localhost"], () => fetch(`http://localhost:${p2}/`).catch((e) => e), { publicOnly: true });
      expect(String(named.cause?.code ?? named.code)).toBe("EGRESS_BLOCKED");
      const literal = await guard.allowFor(["127.0.0.1"], () => fetch(`http://127.0.0.1:${p2}/`).catch((e) => e), { publicOnly: true });
      expect(String(literal.cause?.code ?? literal.code)).toBe("EGRESS_BLOCKED");
      // the same host without publicOnly (configured services) still works
      expect(await (await guard.allowFor(["localhost"], () => fetch(`http://localhost:${p2}/`))).text()).toBe("ok");
    } finally {
      await new Promise((r) => other.close(r));
    }
  });

  it("classifies private and public addresses (SSRF)", () => {
    for (const ip of ["10.1.2.3", "192.168.1.10", "172.20.0.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "203.0.113.7", "2a00:1450::1"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});
