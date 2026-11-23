/**
 * Outgoing network guard (plan N1, AGENTS.md invariant 1: documents stay local).
 *
 * Installed once at process start, it checks every outgoing TCP connection at the lowest
 * level (`net.Socket.prototype.connect`), so it covers fetch, HTTP clients and any library.
 *
 *   allowed always   Unix sockets / named pipes, loopback (127.0.0.0/8, ::1, localhost)
 *   allowed by list  the configured hosts: database, model servers (local and remote)
 *   private only     model servers added from the console: `allowUrls(urls, { privateOnly })`;
 *                    the address is checked when the connection resolves it, as for `publicOnly`
 *   allowed once     a link the user asked to import: `egress.allowFor(host, fn)` opens the
 *                    host only for the async work started inside `fn`; with `publicOnly`
 *                    the address is checked when the connection resolves it (DNS rebinding:
 *                    a check before the request does not hold, the name can resolve again)
 *
 * Everything else fails with code "EGRESS_BLOCKED" and is reported to `onBlocked` (audit).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import net from "node:net";

export interface EgressOptions {
  /** "host" or "host:port"; host names are compared lower case. */
  allow: string[];
  onBlocked?: (e: { host: string; port: number; stack?: string }) => void;
}

const LOOPBACK = (h: string) => h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || h === "0:0:0:0:0:0:0:1";

export class EgressBlockedError extends Error {
  readonly code = "EGRESS_BLOCKED";
  constructor(readonly host: string, readonly port: number) {
    super(`Connessione in uscita bloccata verso ${host}:${port} (non è un host consentito).`);
    this.name = "EgressBlockedError";
  }
}

export class EgressGuard {
  private readonly allowed = new Set<string>();
  /** Hosts allowed only while they resolve to private addresses (not in `allowed`). */
  private readonly allowedPrivate = new Set<string>();
  private readonly scope = new AsyncLocalStorage<{ hosts: Set<string>; publicOnly: Set<string> }>();
  private original: typeof net.Socket.prototype.connect | undefined;
  blocked = 0;

  constructor(private readonly o: EgressOptions) {
    for (const a of o.allow) this.allow(a);
  }

  allow(hostOrHostPort: string): void {
    const v = hostOrHostPort.trim().toLowerCase();
    if (v) this.allowed.add(v);
  }

  /**
   * Allows hosts given as URLs (e.g. the model endpoints) — host and host:port. With
   * `privateOnly`, a connection that only this entry allows fails when the name resolves to a
   * public address (DNS rebinding: a check when the host is added does not hold).
   */
  allowUrls(urls: string[], o: { privateOnly?: boolean } = {}): void {
    for (const u of urls) {
      try {
        const url = new URL(u);
        if (!o.privateOnly) this.allow(url.hostname);
        else if (url.hostname) this.allowedPrivate.add(url.hostname.toLowerCase());
      } catch {
        /* not a URL: ignore */
      }
    }
  }

  isAllowed(host: string, port: number): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (LOOPBACK(h)) return true;
    if (this.allowed.has(h) || this.allowed.has(`${h}:${port}`)) return true;
    const scoped = this.scope.getStore();
    return !!scoped && (scoped.hosts.has(h) || scoped.hosts.has(`${h}:${port}`));
  }

  /**
   * Runs `fn` with `hosts` reachable for the connections it opens (and only those). With
   * `publicOnly`, a connection to these hosts fails when the name resolves to a private address.
   */
  allowFor<T>(hosts: string[], fn: () => Promise<T>, o: { publicOnly?: boolean } = {}): Promise<T> {
    const prev = this.scope.getStore();
    const list = hosts.map((h) => h.toLowerCase().replace(/^\[|\]$/g, ""));
    return this.scope.run(
      { hosts: new Set([...(prev?.hosts ?? []), ...list]), publicOnly: new Set([...(prev?.publicOnly ?? []), ...(o.publicOnly ? list : [])]) },
      fn,
    );
  }

  /** Host that must resolve to public addresses only, for this async context. */
  private publicOnly(host: string): boolean {
    return !!this.scope.getStore()?.publicOnly.has(host.toLowerCase().replace(/^\[|\]$/g, ""));
  }

  install(): this {
    if (this.original) return this;
    const guard = this;
    const original = net.Socket.prototype.connect;
    this.original = original;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      // connect(options[, cb]) | connect(port[, host][, cb]) | connect(path[, cb])
      let host = "localhost";
      let port = 0;
      let isPath = false;
      const a0 = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]; // internal normalized form
      if (typeof a0 === "object" && a0 !== null) {
        const opt = a0 as { host?: string; port?: number | string; path?: string };
        if (opt.path) isPath = true;
        host = opt.host ?? "localhost";
        port = Number(opt.port ?? 0);
      } else if (typeof a0 === "string" && !/^\d+$/.test(a0)) {
        isPath = true;
      } else if (typeof a0 === "number" || typeof a0 === "string") {
        port = Number(a0);
        if (typeof args[1] === "string") host = args[1];
      }
      // public-only host: an address literal is checked here, a name when the socket resolves it
      if (!isPath && guard.publicOnly(host) && typeof a0 === "object" && a0 !== null) {
        const opt = a0 as { lookup?: unknown };
        if (net.isIP(host.replace(/^\[|\]$/g, ""))) {
          if (isNonPublicAddress(host.replace(/^\[|\]$/g, ""))) return guard.block(this, host, port);
        } else {
          opt.lookup = publicLookup;
        }
      }
      if (!isPath && !guard.isAllowed(host, port)) {
        // a private-only host: an address literal is checked here, a name when the socket resolves it
        const h = host.toLowerCase().replace(/^\[|\]$/g, "");
        if (!guard.allowedPrivate.has(h)) return guard.block(this, host, port);
        if (net.isIP(h)) {
          if (!isPrivateAddress(h)) return guard.block(this, host, port);
        } else if (typeof a0 === "object" && a0 !== null) {
          (a0 as { lookup?: unknown }).lookup = privateLookup;
        } else {
          // connect(port, host): no lookup to check the resolved address
          return guard.block(this, host, port);
        }
      }
      return original.apply(this, args as Parameters<typeof original>);
    } as typeof net.Socket.prototype.connect;
    return this;
  }

  private block(socket: net.Socket, host: string, port: number): net.Socket {
    this.blocked++;
    const err = new EgressBlockedError(host, port);
    this.o.onBlocked?.({ host, port, ...(err.stack ? { stack: err.stack } : {}) });
    process.nextTick(() => socket.destroy(err));
    return socket;
  }

  uninstall(): void {
    if (this.original) net.Socket.prototype.connect = this.original;
    this.original = undefined;
  }
}

// ---------------------------------------------------------------------------
// SSRF: a link a user asks to import must point to the public internet.
// ---------------------------------------------------------------------------
/** `lookup` of sockets to public-only hosts: every resolved address must be public. */
function publicLookup(hostname: string, options: dns.LookupOptions, cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const bad = addrs.find((a) => isNonPublicAddress(a.address));
    if (bad || !addrs.length) return cb(new EgressBlockedError(bad?.address ?? hostname, 0), "");
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

/** `lookup` of sockets to private-only hosts: every resolved address must be private. */
function privateLookup(hostname: string, options: dns.LookupOptions, cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const bad = addrs.find((a) => !isPrivateAddress(a.address));
    if (bad || !addrs.length) return cb(new EgressBlockedError(bad?.address ?? hostname, 0), "");
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "");
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}

/**
 * Check of the blocking side (link imports, public-only hosts): true when `ip` must not be
 * reached. Like `isPrivateAddress`, but an IPv4-mapped IPv6 address (::ffff:0:0/96) is
 * classified by its IPv4 address in any textual form: the URL parser rewrites
 * [::ffff:127.0.0.1] to [::ffff:7f00:1], and a dual-stack socket connects to 127.0.0.1.
 */
export function isNonPublicAddress(ip: string): boolean {
  return isPrivateAddress(mappedIPv4(ip) ?? ip);
}

/** The IPv4 address of an IPv4-mapped IPv6 address (::ffff:a.b.c.d, ::ffff:7f00:1, ...), else undefined. */
function mappedIPv4(ip: string): string | undefined {
  const addr = ip.replace(/%.*$/, "").toLowerCase(); // zone id: fe80::1%eth0
  if (!net.isIPv6(addr)) return undefined;
  let text = addr;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const n = groups.map((g) => parseInt(g, 16));
  if (n.length !== 8 || n.slice(0, 5).some((g) => g !== 0) || n[5] !== 0xffff) return undefined;
  return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
}
