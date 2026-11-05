import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROWTH_PER_MS as K,
  autoCashoutWins,
  decideCashout,
  elapsedMsForX100,
  multiplierAt,
  multiplierX100At,
  payoutFor,
} from '../src/index.js';

describe('multiplier curve m(t) = e^(k·t)', () => {
  it('starts at 1.00x and is monotonic', () => {
    expect(multiplierAt(0)).toBe(1);
    expect(multiplierAt(-50)).toBe(1);
    let prev = 0;
    for (let t = 0; t < 120_000; t += 37) {
      const m = multiplierX100At(t);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('hits the documented milestones with k = 0.00006/ms', () => {
    expect(elapsedMsForX100(200)).toBeCloseTo(11_552.45, 1);
    expect(elapsedMsForX100(500)).toBeCloseTo(26_823.98, 1);
    expect(elapsedMsForX100(1000)).toBeCloseTo(38_376.4, 1);
  });

  it('elapsedMsForX100 is the exact inverse: at t(x) the display shows x, never x - 0.01', () => {
    for (let x = 100; x <= 100_000; x += x < 1000 ? 1 : 97) {
      expect(multiplierX100At(elapsedMsForX100(x, K), K)).toBe(x);
    }
  });
});

describe('decideCashout (server-side validation)', () => {
  const startedAt = 1_000_000;
  const crashX100 = 341;
  const crashAt = startedAt + elapsedMsForX100(crashX100, K);
  const base = { startedAt, crashAt, crashX100, k: K };

  it('pays m(receivedAt) floored to the cent', () => {
    const receivedAt = startedAt + elapsedMsForX100(200, K) + 1;
    expect(decideCashout({ ...base, receivedAt })).toEqual({ ok: true, x100: 200 });
  });

  it('accepts 1 ms before the crash and caps at crash - 0.01x', () => {
    const d = decideCashout({ ...base, receivedAt: crashAt - 1 });
    expect(d).toEqual({ ok: true, x100: 340 });
  });

  it('rejects at and after the crash instant', () => {
    expect(decideCashout({ ...base, receivedAt: crashAt })).toEqual({ ok: false, reason: 'CASHOUT_AFTER_CRASH' });
    expect(decideCashout({ ...base, receivedAt: crashAt + 5_000 })).toEqual({
      ok: false,
      reason: 'CASHOUT_AFTER_CRASH',
    });
  });

  it('rejects before the round started', () => {
    expect(decideCashout({ ...base, receivedAt: startedAt - 1 })).toEqual({ ok: false, reason: 'NOT_RUNNING' });
  });

  it('a 1.00x crash rejects every cash-out', () => {
    expect(decideCashout({ startedAt, crashAt: startedAt, crashX100: 100, k: K, receivedAt: startedAt })).toEqual({
      ok: false,
      reason: 'CASHOUT_AFTER_CRASH',
    });
  });

  it('never pays >= the crash point, for any receive time before the crash', () => {
    for (const c of [101, 150, 199, 200, 201, 1234, 99_999]) {
      const cAt = startedAt + elapsedMsForX100(c, K);
      for (const dt of [0.001, 0.5, 1, 3]) {
        const d = decideCashout({ startedAt, crashAt: cAt, crashX100: c, k: K, receivedAt: cAt - dt });
        expect(d.ok && d.x100 < c).toBe(true);
      }
    }
  });
});

describe('auto cash-out and payouts', () => {
  it('wins only when strictly below the crash point', () => {
    expect(autoCashoutWins(200, 201)).toBe(true);
    expect(autoCashoutWins(200, 200)).toBe(false);
    expect(autoCashoutWins(250, 200)).toBe(false);
  });

  it('floors payouts to the cent', () => {
    expect(payoutFor(1000, 341)).toBe(3410);
    expect(payoutFor(333, 150)).toBe(499); // 499.5 -> 499
    expect(payoutFor(10, 100)).toBe(10);
  });
});
