// Logout: the app leaves the session only when the server confirms it. A failed request leaves
// the session cookie valid, so the login screen must not appear.
// session.svelte.ts uses Svelte runes and the root vitest config has no Svelte plugin: $state is
// replaced by the identity function (logout does not depend on reactivity). The modules are
// imported through a non-literal path, so the root lint (no DOM or Svelte types) does not check them.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface Lib {
  session: { me: unknown; apply(me: unknown): void; logout(): Promise<void> };
  ui: { toasts: { text: string; tone: string }[] };
}

const LIB = "../src/lib/";
let lib: Lib;
let fetchMock: ReturnType<typeof vi.fn>;

const me = {
  principal: { id: "usr_a", kind: "user", name: "anna", displayName: "Anna", email: null, role: "member", clearance: 2 },
  via: "session",
  isAdmin: false,
  clearance: 2,
  csrf: "csrf-a",
  vaults: [],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sentCsrf = (call: number) => (fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers["x-cb-csrf"];

beforeAll(async () => {
  vi.stubGlobal("$state", <T>(v: T) => v);
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const session = (await import(LIB + "session.svelte.ts")) as Pick<Lib, "session">;
  const ui = (await import(LIB + "ui.svelte.ts")) as Pick<Lib, "ui">;
  lib = { ...session, ...ui };
});

afterEach(() => {
  lib.ui.toasts = [];
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("logout", () => {
  it.each([
    ["rate limit", () => json(429, { error: { code: "locked", message: "Troppe richieste: attendi qualche secondo." } })],
    ["server error", () => json(500, { error: { code: "internal", message: "Errore interno. Il problema è stato registrato." } })],
    ["network error", () => Promise.reject(new TypeError("fetch failed"))],
  ])("keeps the user signed in and shows an error when the request fails (%s)", async (_name, fail) => {
    fetchMock = vi.fn().mockImplementationOnce(fail).mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    lib.session.apply(me);

    await lib.session.logout();
    expect(lib.session.me).toBe(me);
    expect(lib.ui.toasts).toHaveLength(1);
    expect(lib.ui.toasts[0]!.tone).toBe("error");

    // a second try still carries the CSRF token of the live session, and then ends it
    await lib.session.logout();
    expect(sentCsrf(1)).toBe("csrf-a");
    expect(lib.session.me).toBeNull();
  });

  it("leaves the session and forgets the CSRF token when the server confirms", async () => {
    fetchMock = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    lib.session.apply(me);

    await lib.session.logout();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/logout");
    expect(sentCsrf(0)).toBe("csrf-a");
    expect(lib.session.me).toBeNull();
    expect(lib.ui.toasts).toEqual([]);

    await lib.session.logout();
    expect(sentCsrf(1)).toBeUndefined();
    expect(lib.ui.toasts).toEqual([]);
  });
});
