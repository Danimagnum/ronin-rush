import { hmacSha256Hex } from './crypto.js';
import { crashPointFromHmac, formatX100 } from './crash-point.js';
import { isSeedHex } from './encoding.js';
import { findRoundNumber, isChainLink } from './hash-chain.js';

export interface VerifyRoundInput {
  seed: string;
  publicSalt: string;
  /** Previous round's revealed seed (or the commitment, for round 1): checks one link. */
  previousSeed?: string;
  /** Published commitment: walks the whole chain back to it. */
  commitment?: string;
  maxSteps?: number;
}

export interface VerifyRoundResult {
  crashX100: number;
  crash: string;
  hmac: string;
  /** First 52 bits of the HMAC as hex, the "h" in the formula. */
  h: string;
  linkedToPrevious: boolean | null;
  roundNumber: number | null;
}

/** Recomputes everything a player needs to trust a round. Pure: runs in Node and in the browser. */
export function verifyRound(input: VerifyRoundInput): VerifyRoundResult {
  const seed = input.seed.trim().toLowerCase();
  if (!isSeedHex(seed)) throw new TypeError('Seed must be 64 hex characters');

  const hmac = hmacSha256Hex(seed, input.publicSalt);
  const { crashX100 } = crashPointFromHmac(hmac);

  const linkedToPrevious =
    input.previousSeed !== undefined ? isChainLink(seed, input.previousSeed.trim().toLowerCase()) : null;
  const roundNumber =
    input.commitment !== undefined
      ? findRoundNumber(seed, input.commitment.trim().toLowerCase(), input.maxSteps)
      : null;

  return { crashX100, crash: formatX100(crashX100), hmac, h: hmac.slice(0, 13), linkedToPrevious, roundNumber };
}
