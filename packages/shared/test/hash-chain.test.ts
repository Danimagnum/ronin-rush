import { describe, expect, it } from 'vitest';
import { findRoundNumber, generateHashChain, isChainLink, sha256Hex, verifyRound } from '../src/index.js';

const TERMINAL = 'a1'.repeat(32);
const SALT = 'ronin-rush-public-salt-v1';
// Independently computed with Python: SHA256 applied 5 times to the terminal seed.
const EXPECTED_COMMITMENT = '198138088ecfab98e12a80deb6778bef967be5b6b7822cbc07b5ff3f671b6315';

describe('generateHashChain', () => {
  it('builds seed_i = SHA256(seed_{i+1}) and commits to SHA256(seed_1)', () => {
    const chain = generateHashChain(5, TERMINAL);
    expect(chain.seeds).toHaveLength(5);
    expect(chain.seeds[4]).toBe(TERMINAL);
    expect(chain.seeds[0]).toBe('e164c85c14833e6944429a8b9d8470a652946c8c987796542b8652efa19a237c');
    expect(chain.commitment).toBe(EXPECTED_COMMITMENT);
    for (let i = 0; i < 4; i++) {
      expect(sha256Hex(chain.seeds[i + 1]!)).toBe(chain.seeds[i]);
    }
  });

  it('uses a fresh random terminal seed by default', () => {
    const a = generateHashChain(2);
    const b = generateHashChain(2);
    expect(a.commitment).not.toBe(b.commitment);
  });

  it('validates its arguments', () => {
    expect(() => generateHashChain(0)).toThrow(RangeError);
    expect(() => generateHashChain(3, 'nothex')).toThrow(TypeError);
  });
});

describe('chain verification', () => {
  it('links each revealed seed to the previous one, and round 1 to the commitment', () => {
    const { seeds, commitment } = generateHashChain(5, TERMINAL);
    expect(isChainLink(seeds[0]!, commitment)).toBe(true);
    for (let r = 1; r < seeds.length; r++) {
      expect(isChainLink(seeds[r]!, seeds[r - 1]!)).toBe(true);
    }
    expect(isChainLink(seeds[2]!, seeds[0]!)).toBe(false);
  });

  it('finds the round number by hashing back to the commitment', () => {
    const { seeds, commitment } = generateHashChain(5, TERMINAL);
    for (let r = 1; r <= 5; r++) {
      expect(findRoundNumber(seeds[r - 1]!, commitment)).toBe(r);
    }
    expect(findRoundNumber('b2'.repeat(32), commitment, 50)).toBeNull();
  });

  it('verifyRound returns crash point, h and chain checks in one call', () => {
    const { seeds, commitment } = generateHashChain(5, TERMINAL);
    const res = verifyRound({
      seed: seeds[2]!.toUpperCase(), // user-pasted input is normalised
      publicSalt: SALT,
      previousSeed: seeds[1]!,
      commitment,
    });
    expect(res).toMatchObject({ crashX100: 269, crash: '2.69', linkedToPrevious: true, roundNumber: 3 });
    expect(res.h).toHaveLength(13);
  });
});
