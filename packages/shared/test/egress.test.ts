import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EgressGuard, isNonPublicAddress, isPrivateAddress } from "../src/index.ts";

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
      // the URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1]; a dual-stack socket reaches 127.0.0.1
      const mappedUrl = new URL(`http://[::ffff:127.0.0.1]:${p2}/`);
      const mapped = await guard.allowFor([mappedUrl.hostname], () => fetch(mappedUrl).catch((e) => e), { publicOnly: true });
      expect(String(mapped.cause?.code ?? mapped.code)).toBe("EGRESS_BLOCKED");
      // the same host without publicOnly (configured services) still works
      expect(await (await guard.allowFor(["localhost"], () => fetch(`http://localhost:${p2}/`))).text()).toBe("ok");
    } finally {
      await new Promise((r) => other.close(r));
    }
  });

  it("privateOnly checks the address the connection resolves (DNS rebinding of console endpoints)", async () => {
    const other = http.createServer((_q, r) => r.end("ok"));
    await new Promise<void>((res) => other.listen(0, "127.0.0.1", () => res()));
    const p2 = (other.address() as { port: number }).port;
    // the stub stands for a DNS server the administrator of the name controls
    let answer = ["127.0.0.1"];
    const spy = vi.spyOn(dns, "lookup").mockImplementation(((name: string, _o: dns.LookupOptions, cb: (e: Error | null, a: dns.LookupAddress[]) => void) => {
      const addrs = name === "models.lan.test" ? answer.map((address) => ({ address, family: 4 })) : [];
      process.nextTick(() => cb(addrs.length ? null : Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" }), addrs));
    }) as never);
    try {
      guard.allowUrls([`http://models.lan.test:${p2}/v1`, "http://203.0.113.9:8080"], { privateOnly: true });
      // a private address: the endpoint works as before
      expect(await (await fetch(`http://models.lan.test:${p2}/`)).text()).toBe("ok");
      // the same name now resolves to a public address: a new connection (another port) is refused
      answer = ["203.0.113.7"];
      const rebound = await fetch("http://models.lan.test:18081/").catch((e) => e);
      expect(String(rebound.cause?.code ?? rebound.code)).toBe("EGRESS_BLOCKED");
      answer = ["127.0.0.1", "203.0.113.7"];
      const mixed = await fetch("http://models.lan.test:18082/").catch((e) => e);
      expect(String(mixed.cause?.code ?? mixed.code)).toBe("EGRESS_BLOCKED");
      // a public address literal, and a raw socket that gives no lookup to check
      const literal = await fetch("http://203.0.113.9:8080/").catch((e) => e);
      expect(String(literal.cause?.code ?? literal.code)).toBe("EGRESS_BLOCKED");
      const sock = await new Promise<NodeJS.ErrnoException>((res) => {
        const s = new net.Socket();
        s.on("error", res);
        s.connect(p2, "models.lan.test");
      });
      expect(sock.code).toBe("EGRESS_BLOCKED");
      expect(blocked).toEqual(expect.arrayContaining(["203.0.113.9:8080", `models.lan.test:${p2}`]));
    } finally {
      spy.mockRestore();
      await new Promise((r) => other.close(r));
    }
  });

  it("classifies private and public addresses (SSRF)", () => {
    for (const ip of ["10.1.2.3", "192.168.1.10", "172.20.0.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "203.0.113.7", "2a00:1450::1"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  it("reads IPv4-mapped addresses in any textual form on the blocking side (SSRF)", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:c0a8:b226", "::ffff:a9fe:a9fe", "::FFFF:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:FFFF:10.0.0.1", "::ffff:0:0"]) {
      expect(isNonPublicAddress(ip)).toBe(true);
    }
    for (const ip of ["10.1.2.3", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isNonPublicAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "2a00:1450::1", "::ffff:808:808", "::ffff:8.8.8.8", "::c0a8:b226"]) expect(isNonPublicAddress(ip)).toBe(false);
  });
});
