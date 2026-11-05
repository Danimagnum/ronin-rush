/**
 * Byte/hex helpers. Seeds travel as lowercase hex strings (64 chars = 32 bytes);
 * every hash is computed over the raw bytes, never over the hex text.
 */

const HEX_RE = /^[0-9a-f]*$/;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
    throw new TypeError('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < view.length; i++) s += HEX_TABLE[view[i]!];
  return s;
}

export function isSeedHex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

const encoder = new TextEncoder();
export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}
