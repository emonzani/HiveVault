import { randomBytes } from "node:crypto";

/**
 * ULID-style identifiers: 48-bit millisecond time + 80 random bits, Crockford base32.
 * Sortable by creation time, so btree inserts stay append-mostly (good for large tables).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom = new Uint8Array(10);

function encodeTime(time: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 chars
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Monotonic within the same millisecond: the random part is incremented. */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i]! < 255) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = new Uint8Array(randomBytes(10));
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

/** Prefixed id, e.g. newId("ent") -> "ent_01JB8K3...". */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
