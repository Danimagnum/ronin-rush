import { ClockSyncEstimator, computeClockSample } from '@ronin/shared';

/**
 * The browser's view of server time. The server owns the clock; we only estimate the offset
 * (NTP-style ping/pong over the socket) so the multiplier animates smoothly *locally* from
 * the authoritative startedAt. A monotonic source keeps it immune to the user changing the
 * system clock mid-round.
 */
const estimator = new ClockSyncEstimator({ window: 10, best: 3, smoothing: 0.2 });
const localNow = () => performance.timeOrigin + performance.now();

export const clock = {
  serverNow: () => estimator.serverNow(localNow()),
  addSample: (c0: number, s1: number, s2: number, c3: number) => estimator.add(computeClockSample(c0, s1, s2, c3)),
  localNow,
  get offset() {
    return estimator.offset;
  },
  get rtt() {
    return estimator.rtt;
  },
  get synced() {
    return estimator.synced;
  },
};
