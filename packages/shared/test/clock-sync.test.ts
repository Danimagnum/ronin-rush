import { describe, expect, it } from 'vitest';
import { ClockSyncEstimator, computeClockSample } from '../src/index.js';

describe('computeClockSample (NTP formula)', () => {
  it('recovers offset and rtt on a symmetric path', () => {
    // client is 500 ms behind the server; 40 ms each way; server spends 2 ms
    const c0 = 10_000;
    const s1 = c0 + 500 + 40;
    const s2 = s1 + 2;
    const c3 = s2 - 500 + 40;
    expect(computeClockSample(c0, s1, s2, c3)).toEqual({ rtt: 80, offset: 500 });
  });

  it('error is bounded by rtt/2 on asymmetric paths', () => {
    const c0 = 0;
    const s1 = c0 + 200 + 10; // 10 ms uplink
    const s2 = s1;
    const c3 = s2 - 200 + 90; // 90 ms downlink
    const { rtt, offset } = computeClockSample(c0, s1, s2, c3);
    expect(rtt).toBe(100);
    expect(Math.abs(offset - 200)).toBeLessThanOrEqual(rtt / 2);
  });
});

describe('ClockSyncEstimator', () => {
  const TRUE_OFFSET = -1_234;

  /** Simulates a ping with random asymmetric jitter. */
  function sample(rng: () => number) {
    const up = 15 + rng() * 120;
    const down = 15 + rng() * 120;
    const c0 = 1_000_000;
    const s1 = c0 + TRUE_OFFSET + up;
    const s2 = s1 + 1;
    const c3 = s2 - TRUE_OFFSET + down;
    return computeClockSample(c0, s1, s2, c3);
  }

  it('converges within a few ms by trusting the lowest-RTT samples', () => {
    let seed = 42;
    const rng = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const est = new ClockSyncEstimator();
    expect(est.synced).toBe(false);
    for (let i = 0; i < 30; i++) est.add(sample(rng));
    expect(est.synced).toBe(true);
    expect(Math.abs(est.offset - TRUE_OFFSET)).toBeLessThan(25);
    expect(est.rtt).toBeGreaterThan(30);
    expect(est.serverNow(5_000)).toBeCloseTo(5_000 + est.offset);
  });

  it('smooths small corrections and snaps large ones', () => {
    const est = new ClockSyncEstimator({ window: 1, best: 1, smoothing: 0.5, snapThresholdMs: 250 });
    est.add({ rtt: 10, offset: 100 });
    expect(est.offset).toBe(100);
    est.add({ rtt: 10, offset: 120 });
    expect(est.offset).toBe(110); // half-way
    est.add({ rtt: 10, offset: 5_000 });
    expect(est.offset).toBe(5_000); // snapped (e.g. laptop woke up)
  });
});

