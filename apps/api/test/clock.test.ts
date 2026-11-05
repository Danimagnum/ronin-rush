import { describe, expect, it } from 'vitest';
import { MonotonicClock, ReferenceAlignedClock } from '../src/clock/clock';

describe('ReferenceAlignedClock', () => {
  it('aligns to the reference using the lowest-RTT sample', async () => {
    let local = 1_000;
    const base = { now: () => local };
    const delays = [40, 4, 25]; // round trips of 80, 8, 50 ms
    let i = 0;
    const REF_OFFSET = 5_000;
    const read = async () => {
      const d = delays[i++ % delays.length]!;
      local += d; // uplink
      const ref = local + REF_OFFSET;
      local += d; // downlink
      return ref;
    };
    const clock = new ReferenceAlignedClock(read, base);
    const report = await clock.sync(3);
    expect(report.rttMs).toBe(8);
    expect(report.offsetMs).toBe(REF_OFFSET);
    expect(clock.now()).toBe(local + REF_OFFSET);
  });

  it('MonotonicClock tracks wall time closely and never goes backwards', () => {
    const c = new MonotonicClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(50);
    let prev = c.now();
    for (let i = 0; i < 10_000; i++) {
      const n = c.now();
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});
