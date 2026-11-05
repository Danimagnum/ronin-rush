/**
 * Synchronous SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) in plain TypeScript.
 *
 * Why not Web Crypto? `crypto.subtle` is async and costs ~40-60 µs per call (thread-pool
 * hop), which makes walking a 100k-link hash chain on the Verify page take seconds and the
 * 1M-round distribution test take minutes. This implementation runs at ~1-2 µs per hash,
 * identically in Node and the browser, with no dependencies.
 *
 * It only hashes public or soon-to-be-public data (seeds are revealed after each round),
 * so constant-time concerns don't apply. Correctness is pinned by NIST vectors, RFC 4231
 * HMAC vectors and a randomized cross-check against Web Crypto (test/sha256.test.ts).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Uint32Array(64);

function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    W[i] = ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15]!;
    const w2 = W[i - 2]!;
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
  }

  let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
  let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;

  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }

  state[0] = (state[0]! + a) >>> 0; state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0; state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0; state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0; state[7] = (state[7]! + h) >>> 0;
}

/** SHA-256 digest of `data` (32 bytes). */
export function sha256(data: Uint8Array): Uint8Array {
  const state = new Uint32Array(H0);
  const len = data.length;
  const fullBlocks = Math.floor(len / 64);
  for (let i = 0; i < fullBlocks; i++) compress(state, data, i * 64);

  // Padding: remaining bytes + 0x80 + zeros + 64-bit big-endian bit length.
  const rem = len - fullBlocks * 64;
  const tailLen = rem < 56 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(data.subarray(fullBlocks * 64));
  tail[rem] = 0x80;
  const bitLen = len * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  tail[tailLen - 8] = hi >>> 24; tail[tailLen - 7] = hi >>> 16; tail[tailLen - 6] = hi >>> 8; tail[tailLen - 5] = hi;
  tail[tailLen - 4] = lo >>> 24; tail[tailLen - 3] = lo >>> 16; tail[tailLen - 2] = lo >>> 8; tail[tailLen - 1] = lo;
  for (let off = 0; off < tailLen; off += 64) compress(state, tail, off);

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const v = state[i]!;
    out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v;
  }
  return out;
}

const BLOCK = 64;

/** HMAC-SHA256(key, message) per RFC 2104. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key.length > BLOCK ? sha256(key) : key;
  const padded = new Uint8Array(BLOCK);
  padded.set(k);
  k = padded;

  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha256(inner), BLOCK);
  return sha256(outer);
}
