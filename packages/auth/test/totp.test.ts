import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, KeyedHash, SecretBox, safeEqual, sha256hex } from "../src/crypto.ts";
import { hotp, otpauthUri, totp, verifyTotp } from "../src/totp.ts";
import { randomBytes } from "node:crypto";

// RFC 6238 appendix B: seed "12345678901234567890" (SHA1), 8 digits
const RFC_SECRET = Buffer.from("12345678901234567890");
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [t, code] of RFC_VECTORS) expect(totp(RFC_SECRET, t * 1000, 8)).toBe(code);
  });

  it("matches the RFC 4226 HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((c, i) => expect(hotp(RFC_SECRET, i)).toBe(c));
  });

  it("accepts ±1 step of clock drift and refuses reuse", () => {
    const now = 1_800_000_000_000;
    const code = totp(RFC_SECRET, now - 30_000);
    const step = verifyTotp(RFC_SECRET, code, { now });
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { now, lastStep: step! })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 90_000), { now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12 34 5", { now })).toBeNull();
  });

  it("builds an otpauth URI that authenticator apps read", () => {
    const uri = otpauthUri(RFC_SECRET, "nome.cognomebbb");
    expect(uri).toMatch(/^otpauth:\/\/totp\/HiveVault%3Anome\.cognomebbb\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=HiveVault/);
  });
});

describe("crypto helpers", () => {
  it("base32 round-trips", () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("secret box seals with associated data", () => {
    const box = new SecretBox(randomBytes(32), "totp");
    const sealed = box.seal(Buffer.from("seme"), "usr_1");
    expect(box.open(sealed, "usr_1").toString()).toBe("seme");
    expect(() => box.open(sealed, "usr_2")).toThrow(); // bound to its principal
  });

  it("keyed hash depends on the master key and the purpose", () => {
    const key = randomBytes(32);
    const h = new KeyedHash(key, "recovery");
    expect(h.hex("usr_1:ABCDEFGH")).toBe(new KeyedHash(key, "recovery").hex("usr_1:ABCDEFGH"));
    expect(h.hex("usr_1:ABCDEFGH")).toMatch(/^[0-9a-f]{64}$/);
    expect(h.hex("usr_1:ABCDEFGH")).not.toBe(sha256hex("usr_1:ABCDEFGH"));
    expect(h.hex("usr_1:ABCDEFGH")).not.toBe(new KeyedHash(randomBytes(32), "recovery").hex("usr_1:ABCDEFGH"));
    expect(h.hex("usr_1:ABCDEFGH")).not.toBe(new KeyedHash(key, "other").hex("usr_1:ABCDEFGH"));
  });

  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
