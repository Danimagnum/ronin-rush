/**
 * The server owns the clock. Every timestamp that decides money — bet acceptance,
 * cash-out receive time, crash instant — comes from a Clock, never from a client.
 */
export interface Clock {
  /** Epoch milliseconds (may be fractional). */
  now(): number;
}

/** Wall-clock anchored once, then advanced by the monotonic timer: immune to NTP steps on the host. */
export class MonotonicClock implements Clock {
  private readonly origin = Date.now() - performance.now();
  now(): number {
    return this.origin + performance.now();
  }
}

export interface ClockSyncReport {
  offsetMs: number;
  rttMs: number;
  syncedAt: number;
}

/**
 * Aligns this instance with a shared reference (Redis `TIME`), so that a timestamp taken by a
 * relay instance when a cash-out arrives is directly comparable with the crash instant
 * computed by the leader on another machine. Keeps the lowest-RTT sample of each burst.
 */
export class ReferenceAlignedClock implements Clock {
  private offset = 0;
  private report: ClockSyncReport | null = null;

  constructor(
    private readonly readReferenceMs: () => Promise<number>,
    private readonly base: Clock = new MonotonicClock(),
  ) {}

  now(): number {
    return this.base.now() + this.offset;
  }

  get lastSync(): ClockSyncReport | null {
    return this.report;
  }

  async sync(samples = 5): Promise<ClockSyncReport> {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < samples; i++) {
      const t0 = this.base.now();
      const ref = await this.readReferenceMs();
      const t1 = this.base.now();
      const rtt = t1 - t0;
      const offset = ref + rtt / 2 - t1;
      if (!best || rtt < best.rtt) best = { rtt, offset };
    }
    this.offset = best!.offset;
    this.report = { offsetMs: best!.offset, rttMs: best!.rtt, syncedAt: this.now() };
    return this.report;
  }
}
