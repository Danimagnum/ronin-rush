/**
 * Hash helpers over hex strings. Hashing uses the synchronous, isomorphic implementation in
 * ./sha256.ts so server and Verify page run the exact same code; randomness comes from the
 * platform CSPRNG (crypto.getRandomValues), available in Node >= 20 and all browsers.
 */
import { bytesToHex, hexToBytes, utf8 } from './encoding.js';
import { hmacSha256, sha256 } from './sha256.js';

/** SHA-256 of the raw bytes encoded by `hex`; returns lowercase hex. */
export function sha256Hex(hex: string): string {
  return bytesToHex(sha256(hexToBytes(hex)));
}

/** HMAC-SHA256 with key = seed bytes and message = UTF-8 salt; returns lowercase hex. */
export function hmacSha256Hex(seedHex: string, message: string): string {
  return bytesToHex(hmacSha256(hexToBytes(seedHex), utf8(message)));
}

/** 32 cryptographically secure random bytes as hex — the terminal seed of a chain. */
export function randomSeedHex(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error('crypto.getRandomValues is not available in this runtime');
  const bytes = new Uint8Array(32);
  c.getRandomValues(bytes);
  return bytesToHex(bytes);
}
