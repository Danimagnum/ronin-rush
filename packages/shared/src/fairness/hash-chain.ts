import { randomSeedHex, sha256Hex } from './crypto.js';
import { isSeedHex } from './encoding.js';

/**
 * Hash chain of server seeds.
 *
 *   seed_N           = 32 random bytes (generated first, used last)
 *   seed_i           = SHA256(seed_{i+1})
 *   commitment (C)   = SHA256(seed_1)      <- published before launch
 *
 * Round r uses seed_r, so rounds walk the chain "forwards" (1, 2, 3 …) while the
 * chain was built "backwards". Revealing seed_r lets anyone check
 * SHA256(seed_r) === seed_{r-1} (or === C for r = 1), yet nobody can derive
 * seed_{r+1} from it: that would require inverting SHA-256.
 */
export interface HashChain {
  /** seeds[0] is seed_1 (round 1), seeds[n-1] is seed_N (terminal). */
  seeds: string[];
  commitment: string;
}

export function generateHashChain(length: number, terminalSeed: string = randomSeedHex()): HashChain {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('length must be a positive integer');
  if (!isSeedHex(terminalSeed)) throw new TypeError('terminalSeed must be 64 lowercase hex chars');

  const seeds = new Array<string>(length);
  seeds[length - 1] = terminalSeed;
  for (let i = length - 2; i >= 0; i--) {
    seeds[i] = sha256Hex(seeds[i + 1]!);
  }
  const commitment = sha256Hex(seeds[0]!);
  return { seeds, commitment };
}

/** True when `seed` is the direct preimage of `next` (previous round's seed, or C for round 1). */
export function isChainLink(seed: string, next: string): boolean {
  if (!isSeedHex(seed) || !isSeedHex(next)) return false;
  return sha256Hex(seed) === next;
}

/**
 * Hashes `seed` repeatedly until it reaches the commitment.
 * Returns the round number r (1-based) such that SHA256^r(seed) === C, or null if
 * not found within `maxSteps`. This is what lets the Verify page prove that a
 * revealed seed belongs to the published chain without trusting any other data.
 */
export function findRoundNumber(seed: string, commitment: string, maxSteps = 1_000_000): number | null {
  if (!isSeedHex(seed) || !isSeedHex(commitment)) return null;
  let current = seed;
  for (let step = 1; step <= maxSteps; step++) {
    current = sha256Hex(current);
    if (current === commitment) return step;
  }
  return null;
}
