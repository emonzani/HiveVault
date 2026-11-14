// Secrets never reach the log: secret field names at any depth, Bearer tokens and API keys in text.
import { describe, expect, it } from "vitest";
import { redact } from "../src/log.ts";

describe("log redaction", () => {
  it("hides secret fields and keys inside strings, keeps the rest", () => {
    const out = redact({
      user: "nome.cognomekkk",
      code: "123456",
      nested: { apiKey: "x", sessions: 3, list: [{ token: "t" }] },
      header: "Authorization: Bearer abc.def-123",
      msg: "chiave cb_01ABCDEF_0123456789abcdefXYZ usata",
    }) as Record<string, unknown>;
    expect(out.user).toBe("nome.cognomekkk");
    expect(out.code).toBe("[nascosto]");
    expect(out.nested).toEqual({ apiKey: "[nascosto]", sessions: 3, list: [{ token: "[nascosto]" }] });
    expect(out.header).toBe("Authorization: Bearer [nascosto]");
    expect(out.msg).toBe("chiave cb_[nascosto] usata");
  });
});
