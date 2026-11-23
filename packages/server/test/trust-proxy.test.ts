// TRUST_PROXY: parsing, and the client IP (req.ip) that reaches authentication and the rate
// limits when a client forges X-Forwarded-For. No database: the auth service is a stub.
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ipAllowed, type AuthService, type Authenticated } from "@cb/auth";
import type { SearchEngine, VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { buildApp } from "../src/app.ts";
import { parseTrustProxy } from "../src/config.ts";

describe("TRUST_PROXY parsing", () => {
  it("is empty without a proxy", () => {
    for (const v of [undefined, "", "  ", "false", "FALSE", "0", "no", "off"]) expect(parseTrustProxy(v)).toEqual([]);
  });

  it("refuses the old boolean values", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on"]) expect(() => parseTrustProxy(v)).toThrow(/no longer accepted.*addresses of the reverse proxy/);
  });

  it("accepts IP addresses and CIDR ranges", () => {
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustProxy(" 127.0.0.1 , ::1,10.0.0.0/8,fd00::/8, ::ffff:10.1.2.3, 192.168.1.0/32 ")).toEqual([
      "127.0.0.1",
      "::1",
      "10.0.0.0/8",
      "fd00::/8",
      "::ffff:10.1.2.3",
      "192.168.1.0/32",
    ]);
  });

  it("refuses invalid entries", () => {
    for (const v of ["loopback", "uniquelocal", "localhost", "proxy.azienda.local", "127.1", "010.0.0.1", "10.0.0.0/33", "::1/129", "10.0.0.0/", "10.0.0.0/8x", "10.0.0.0/-1", "10.0.0.0/255.0.0.0", "127.0.0.1,", "127.0.0.1,,::1", "10.0.0.1/8/8"]) {
      expect(() => parseTrustProxy(v), v).toThrow(/not an IP address or a CIDR range/);
    }
  });

  it("refuses ranges that cover every client", () => {
    for (const v of ["0.0.0.0/0", "::/0", "127.0.0.1,0.0.0.0/0", "::ffff:0.0.0.0/96", "::ffff:10.0.0.1/96", "::/64"]) {
      expect(() => parseTrustProxy(v), v).toThrow(/covers every client address/);
    }
    // a part of the IPv4-mapped range is a normal range
    expect(parseTrustProxy("::ffff:10.0.0.0/104")).toEqual(["::ffff:10.0.0.0/104"]);
  });
});

// ---------------------------------------------------------------------------
// req.ip through buildApp. The stub authenticate() applies the real allowlist check
// (ipAllowed) of an API key restricted to the CI server 10.0.5.20.
// ---------------------------------------------------------------------------
const CI = "10.0.5.20";
const ATTACKER = "203.0.113.9";
const seen: (string | null | undefined)[] = [];
const auth = {
  authenticate: async (input: { bearer?: string; ip?: string | null }) => {
    seen.push(input.ip);
    if (input.bearer !== "cb_test" || !ipAllowed(input.ip, [`${CI}/32`])) return null;
    return { principal: { id: "ci", ratePerMin: null }, via: "apikey" } as unknown as Authenticated;
  },
} as unknown as AuthService;

const apps: FastifyInstance[] = [];
async function app(trustProxy?: string[]): Promise<FastifyInstance> {
  const a = await buildApp({
    sql: { unsafe: () => ({}) } as unknown as Sql, // routes build SQL fragments at registration
    auth,
    vaults: {} as VaultStore,
    search: {} as SearchEngine,
    secureCookies: false,
    loginRateLimitPerMin: 2,
    ...(trustProxy ? { trustProxy } : {}),
  });
  a.get("/api/probe-ip", async (req) => ({ ip: req.ip }));
  a.get("/api/auth/probe-ip", async (req) => ({ ip: req.ip })); // login rate limit
  a.get("/api/probe-key", async (req) => ({ ip: req.ip, key: req.auth?.principal.id ?? null }));
  apps.push(a);
  return a;
}
afterAll(async () => {
  for (const a of apps) await a.close();
});

const ipOf = async (a: FastifyInstance, remoteAddress: string, xff?: string) =>
  (await a.inject({ method: "GET", url: "/api/probe-ip", remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {} })).json().ip as string;

describe("client IP with a forged X-Forwarded-For", () => {
  it("direct connection without TRUST_PROXY: the socket address", async () => {
    for (const a of [await app(), await app([])]) expect(await ipOf(a, ATTACKER, CI)).toBe(ATTACKER);
  });

  it("direct connection from an address that is not a listed proxy: the socket address", async () => {
    const a = await app(["127.0.0.1", "::1"]);
    expect(await ipOf(a, ATTACKER, CI)).toBe(ATTACKER);
    expect(await ipOf(a, ATTACKER, `${CI}, 127.0.0.1`)).toBe(ATTACKER);
  });

  it("listed proxy: the client address it adds, not the forged entries before it", async () => {
    const a = await app(["127.0.0.1", "::1"]);
    // a proxy that overwrites X-Forwarded-For
    expect(await ipOf(a, "127.0.0.1", ATTACKER)).toBe(ATTACKER);
    expect(await ipOf(a, "::1", ATTACKER)).toBe(ATTACKER);
    // dual-stack socket: IPv4-mapped address of the proxy
    expect(await ipOf(a, "::ffff:127.0.0.1", ATTACKER)).toBe(ATTACKER);
    // a proxy that appends to the value of the client
    expect(await ipOf(a, "127.0.0.1", `${CI}, ${ATTACKER}`)).toBe(ATTACKER);
    expect(await ipOf(a, "127.0.0.1", `${CI}, 127.0.0.1, ${ATTACKER}`)).toBe(ATTACKER);
    // no header: the proxy address
    expect(await ipOf(a, "127.0.0.1")).toBe("127.0.0.1");
  });

  it("chain of listed proxies: the first address that is not a proxy, from the right", async () => {
    const a = await app(["10.0.0.2", "10.1.0.0/16"]);
    expect(await ipOf(a, "10.0.0.2", `${ATTACKER}, 10.1.4.4`)).toBe(ATTACKER);
    expect(await ipOf(a, "10.0.0.2", `${CI}, ${ATTACKER}, 10.1.4.4`)).toBe(ATTACKER);
    // a proxy that is not listed stops the chain: its address is the client
    expect(await ipOf(a, "10.0.0.2", `${CI}, 10.2.0.1`)).toBe("10.2.0.1");
  });

  it("API key allowlist: the forged address of the allowed host does not pass", async () => {
    const a = await app(["127.0.0.1"]);
    const call = async (remoteAddress: string, xff: string) => {
      const res = await a.inject({ method: "GET", url: "/api/probe-key", remoteAddress, headers: { authorization: "Bearer cb_test", "x-forwarded-for": xff } });
      return res.statusCode;
    };
    seen.length = 0;
    expect(await call(ATTACKER, CI)).toBe(401); // direct, forged header
    expect(await call("127.0.0.1", `${CI}, ${ATTACKER}`)).toBe(401); // through the proxy, forged header
    expect(seen).toEqual([ATTACKER, ATTACKER]);
    expect(await call("127.0.0.1", CI)).toBe(200); // the CI server through the proxy
    expect(await call(CI, "198.51.100.1")).toBe(200); // the CI server directly
  });

  it("login rate limit per IP: a new forged address does not open a new bucket", async () => {
    const direct = await app(["127.0.0.1"]);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await direct.inject({ method: "GET", url: "/api/auth/probe-ip", remoteAddress: ATTACKER, headers: { "x-forwarded-for": `198.51.100.${i}` } })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
    // through the proxy, every real client has its own bucket
    const proxied = await app(["127.0.0.1"]);
    for (let i = 0; i < 4; i++) {
      expect((await proxied.inject({ method: "GET", url: "/api/auth/probe-ip", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": `198.51.100.${i}` } })).statusCode).toBe(200);
    }
  });
});
