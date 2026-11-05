import { describe, expect, it } from 'vitest';
import { crashPointFromHmac, generateHashChain, hmacSha256Hex } from '../src/index.js';

/**
 * Simulates 1,000,000 rounds through the real pipeline (hash chain -> HMAC -> formula)
 * and checks the empirical survival function against the theoretical P(crash >= x) = 0.99 / x.
 *
 * Tolerance: each estimate is a binomial proportion, so we allow 5 standard errors
 * (sqrt(p(1-p)/n)). A fixed terminal seed keeps the run reproducible. With a correct
 * implementation every |z| sits well under 2; an off-by-one such as using 100 instead
 * of 99 shifts P by 1% relative, which at x = 1.01 alone is a ~7σ failure.
 */
const ROUNDS = 1_000_000;
const SALT = 'ronin-rush-public-salt-v1';
const TERMINAL = 'c3'.repeat(32);
const THRESHOLDS_X100 = [101, 110, 125, 150, 200, 300, 500, 1000, 2000, 5000, 10000];
const Z = 5;

const se = (p: number, n: number) => Math.sqrt((p * (1 - p)) / n);

describe(`crash distribution over ${ROUNDS.toLocaleString('en')} rounds`, () => {
  it('matches P(crash >= x) = 0.99 / x and yields the expected house edge', () => {
    const { seeds } = generateHashChain(ROUNDS, TERMINAL);

    const atLeast = new Array<number>(THRESHOLDS_X100.length).fill(0);
    let instantBusts = 0; // crash == 1.00x
    let winsAt2x = 0; // auto cash-out at 2.00x wins only when crash > 2.00x

    for (const seed of seeds) {
      const { crashX100 } = crashPointFromHmac(hmacSha256Hex(seed, SALT));
      if (crashX100 === 100) instantBusts++;
      if (crashX100 > 200) winsAt2x++;
      for (let i = 0; i < THRESHOLDS_X100.length; i++) {
        if (crashX100 >= THRESHOLDS_X100[i]!) atLeast[i]!++;
      }
    }

    const rows = THRESHOLDS_X100.map((x100, i) => {
      const expected = 99 / x100; // = 0.99 / (x100 / 100)
      const observed = atLeast[i]! / ROUNDS;
      return { x: (x100 / 100).toFixed(2), expected, observed, z: (observed - expected) / se(expected, ROUNDS) };
    });
    console.table(
      rows.map((r) => ({ x: r.x, expected: r.expected.toFixed(5), observed: r.observed.toFixed(5), z: r.z.toFixed(2) })),
    );
    for (const r of rows) {
      expect(Math.abs(r.z), `x=${r.x} observed=${r.observed} expected=${r.expected}`).toBeLessThan(Z);
    }

    // Instant bust: 99/(1-U) < 101 cents  <=>  U < 2/101, so P(crash = 1.00x) = 2/101 ≈ 1.98%.
    const pInstant = 2 / 101;
    expect(Math.abs(instantBusts / ROUNDS - pInstant)).toBeLessThan(Z * se(pInstant, ROUNDS));

    // RTP of "always auto cash-out at 2.00x" = 2 · P(crash >= 2.01) = 2 · 0.99/2.01 ≈ 98.5%.
    const pWin = 99 / 201;
    const rtp = (2 * winsAt2x) / ROUNDS;
    expect(Math.abs(rtp - 2 * pWin)).toBeLessThan(Z * 2 * se(pWin, ROUNDS));
  });
});
