/**
 * TOTP (RFC 6238 over HOTP, RFC 4226): HMAC-SHA1, 30-second steps, 6 digits — the settings
 * every authenticator app supports.
 */
import { createHmac, randomBytes } from "node:crypto";
import { base32Encode } from "./crypto.ts";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): Buffer {
  return randomBytes(20); // 160 bits, as recommended by RFC 4226
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (now = Date.now()): number => Math.floor(now / 1000 / TOTP_STEP_SECONDS);

export function totp(secret: Buffer, now = Date.now(), digits = TOTP_DIGITS, algorithm = "sha1"): string {
  return hotp(secret, totpStep(now), digits, algorithm);
}

/**
 * Checks a code in the window [step-1, step+1] (clock drift of ±30 s).
 * Returns the matched step, or null. Steps ≤ lastStep are refused: a code works once.
 */
export function verifyTotp(secret: Buffer, code: string, opts: { now?: number; window?: number; lastStep?: number } = {}): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const step = totpStep(opts.now);
  const w = opts.window ?? 1;
  for (let d = -w; d <= w; d++) {
    const s = step + d;
    if (opts.lastStep !== undefined && s <= opts.lastStep) continue;
    // constant time per comparison is not needed: the attacker sees only success/failure,
    // and attempts are rate limited
    if (hotp(secret, s) === clean) return s;
  }
  return null;
}

export function otpauthUri(secret: Buffer, account: string, issuer = "HiveVault"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
