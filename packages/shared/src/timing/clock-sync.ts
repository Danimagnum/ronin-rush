/**
 * NTP-style clock offset estimation used by the browser.
 *
 *   c0 ── ping ──▶ s1   (server receive)
 *   c3 ◀── pong ── s2   (server send)
 *
 *   rtt    = (c3 - c0) - (s2 - s1)
 *   offset = ((s1 - c0) + (s2 - c3)) / 2      => serverTime ≈ clientTime + offset
 *
 * The offset error is bounded by rtt/2 for asymmetric paths, so we trust the samples with
 * the lowest RTT: keep a window, take the `best` lowest-RTT ones and use their median offset.
 * Updates are smoothed so the multiplier animation never visibly jumps, except for large
 * corrections (e.g. a laptop waking from sleep), which snap immediately.
 */

export interface ClockSample {
  rtt: number;
  offset: number;
}

export function computeClockSample(c0: number, s1: number, s2: number, c3: number): ClockSample {
  return { rtt: Math.max(0, c3 - c0 - (s2 - s1)), offset: (s1 - c0 + (s2 - c3)) / 2 };
}

export interface ClockSyncOptions {
  window?: number;
  best?: number;
  smoothing?: number;
  snapThresholdMs?: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export class ClockSyncEstimator {
  private readonly samples: ClockSample[] = [];
  private currentOffset: number | null = null;
  private readonly window: number;
  private readonly best: number;
  private readonly smoothing: number;
  private readonly snapThresholdMs: number;

  constructor(opts: ClockSyncOptions = {}) {
    this.window = opts.window ?? 8;
    this.best = opts.best ?? 3;
    this.smoothing = opts.smoothing ?? 0.25;
    this.snapThresholdMs = opts.snapThresholdMs ?? 250;
  }

  add(sample: ClockSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.window) this.samples.shift();

    const target = median(
      [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, this.best).map((s) => s.offset),
    );
    if (this.currentOffset === null || Math.abs(target - this.currentOffset) > this.snapThresholdMs) {
      this.currentOffset = target;
    } else {
      this.currentOffset += (target - this.currentOffset) * this.smoothing;
    }
  }

  get synced(): boolean {
    return this.currentOffset !== null;
  }

  /** Estimated server − client offset in ms (0 until the first sample). */
  get offset(): number {
    return this.currentOffset ?? 0;
  }

  /** Median RTT of the window: the latency shown to the player. */
  get rtt(): number {
    return this.samples.length ? median(this.samples.map((s) => s.rtt)) : 0;
  }

  serverNow(clientNow: number): number {
    return clientNow + this.offset;
  }
}
