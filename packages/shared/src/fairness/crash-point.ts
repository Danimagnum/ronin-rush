import { hmacSha256Hex } from './crypto.js';

/** 1% house edge: the "99" in floor(99 / (1 - U)). */
export const HOUSE_EDGE_NUMERATOR = 99n;
export const MIN_CRASH_X100 = 100;

const TWO_POW_52 = 1n << 52n;

/**
 * Crash point (multiplier x100, i.e. 341 = 3.41x) from an HMAC-SHA256 hex digest.
 *
 *   h = first 52 bits of the digest (13 hex chars)
 *   U = h / 2^52
 *   crash = max(1.00, floor(99 / (1 - U)) / 100)
 *
 * Computed with BigInt as floor(99 * 2^52 / (2^52 - h)) so there is no
 * floating-point rounding anywhere: server and browser always agree to the cent.
 *
 * Note: the result can exceed Number.MAX_SAFE_INTEGER only when U > 1 - 99/9e15,
 * a probability of ~1e-14 per round; we still return an exact bigint alongside.
 */
export function crashPointFromHmac(hmacHex: string): { crashX100: number; crashX100Big: bigint; h: bigint } {
  if (!/^[0-9a-f]{13,}$/i.test(hmacHex)) {
    throw new TypeError('HMAC digest must be hex with at least 13 chars');
  }
  const h = BigInt('0x' + hmacHex.slice(0, 13));
  const cents = (HOUSE_EDGE_NUMERATOR * TWO_POW_52) / (TWO_POW_52 - h); // BigInt division floors
  const crashX100Big = cents < BigInt(MIN_CRASH_X100) ? BigInt(MIN_CRASH_X100) : cents;
  return { crashX100: Number(crashX100Big), crashX100Big, h };
}

/** Crash point x100 for a round, from its server seed and the public salt. */
export function crashPointX100(seedHex: string, publicSalt: string): number {
  const digest = hmacSha256Hex(seedHex, publicSalt);
  return crashPointFromHmac(digest).crashX100;
}

/** 341 -> "3.41" (exact, no float formatting). */
export function formatX100(x100: number): string {
  const whole = Math.floor(x100 / 100);
  const frac = String(x100 % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}
