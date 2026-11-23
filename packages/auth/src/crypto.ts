import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Random token in base64url (default 32 bytes = 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Constant-time comparison of two strings (different lengths compare as different). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, no padding) — the format of TOTP secrets in authenticator apps.
// ---------------------------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Secret box: AES-256-GCM with a key derived from the master key, for secrets that the server
// must read again (TOTP seeds). Format: iv (12) | tag (16) | ciphertext.
// ---------------------------------------------------------------------------
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: Buffer, purpose: string) {
    this.key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.from("cb-auth-v1"), Buffer.from(purpose), 32));
  }

  seal(plain: Buffer, aad = ""): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    if (aad) c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  open(sealed: Buffer, aad = ""): Buffer {
    const d = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, 12));
    d.setAuthTag(sealed.subarray(12, 28));
    if (aad) d.setAAD(Buffer.from(aad));
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  }
}

// ---------------------------------------------------------------------------
// Keyed hash: HMAC-SHA256 with a key derived from the master key, for short secrets that the
// server only compares (recovery codes). A copy of the database alone cannot test a guess.
// ---------------------------------------------------------------------------
export class KeyedHash {
  private readonly key: Buffer;

  constructor(masterKey: Buffer, purpose: string) {
    this.key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.from("cb-auth-hmac-v1"), Buffer.from(purpose), 32));
  }

  hex(data: string): string {
    return createHmac("sha256", this.key).update(data).digest("hex");
  }
}
