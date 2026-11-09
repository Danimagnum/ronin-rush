import type Redis from 'ioredis';

export interface LeaderElectorOptions {
  instanceId: string;
  key?: string;
  /** Lease length. A crashed leader is replaced after at most ttlMs + renewEveryMs. */
  ttlMs?: number;
  renewEveryMs?: number;
  /**
   * Highest token already used downstream (e.g. the database fence). Guarantees a fresh token
   * stays above it even if Redis lost its counter (restart without persistence, failover).
   */
  minToken?: () => Promise<number>;
}

export type LeadershipListener = (isLeader: boolean, fencingToken: number | null) => void;

// Extend the lease only if we still own it (compare-and-pexpire).
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
// Release only our own lease (compare-and-delete).
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Single-leader election on a Redis lease (SET NX PX + compare-and-renew).
 *
 * Every acquisition also INCRs a fencing token. Writes made on behalf of the leader carry it
 * (e.g. rounds.fencing_token), so a paused ex-leader that wakes up after its lease expired
 * cannot overwrite the work of its successor even before it notices it lost the lease.
 *
 * Failure policy: if Redis is unreachable we step down once the lease could have expired on
 * the server side, never later — two leaders are worse than a short pause between rounds.
 */
export class LeaderElector {
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly renewEveryMs: number;
  private interval: NodeJS.Timeout | null = null;
  private leader = false;
  private token: number | null = null;
  private lastConfirmedAt = 0;
  private readonly listeners = new Set<LeadershipListener>();
  private ticking = false;

  constructor(
    private readonly redis: Redis,
    private readonly opts: LeaderElectorOptions,
  ) {
    this.key = opts.key ?? 'ronin:leader';
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.renewEveryMs = opts.renewEveryMs ?? 1_000;
  }

  get isLeader(): boolean {
    return this.leader;
  }

  get fencingToken(): number | null {
    return this.token;
  }

  onChange(listener: LeadershipListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.interval) return;
    await this.tick();
    this.interval = setInterval(() => void this.tick(), this.renewEveryMs);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.leader) {
      await this.redis.eval(RELEASE, 1, this.key, this.opts.instanceId).catch(() => undefined);
      this.setLeader(false, null);
    }
  }

  /** One election step; exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = Date.now();
    try {
      if (this.leader) {
        const renewed = await this.redis.eval(RENEW, 1, this.key, this.opts.instanceId, String(this.ttlMs));
        if (renewed === 1) this.lastConfirmedAt = startedAt;
        else this.setLeader(false, null); // someone else owns it now
      } else {
        const ok = await this.redis.set(this.key, this.opts.instanceId, 'PX', this.ttlMs, 'NX');
        if (ok === 'OK') {
          const token = await this.nextToken();
          this.lastConfirmedAt = startedAt;
          this.setLeader(true, token);
        }
      }
    } catch {
      // Redis unreachable: keep leading only while our lease is certainly still valid.
      if (this.leader && Date.now() - this.lastConfirmedAt >= this.ttlMs - this.renewEveryMs) {
        this.setLeader(false, null);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async nextToken(): Promise<number> {
    const counter = `${this.key}:fencing`;
    let token = await this.redis.incr(counter);
    const floor = this.opts.minToken ? await this.opts.minToken() : 0;
    if (token <= floor) {
      // Only the lease holder gets here, so raising the counter cannot race another leader.
      await this.redis.set(counter, floor);
      token = await this.redis.incr(counter);
    }
    return token;
  }

  private setLeader(isLeader: boolean, token: number | null): void {
    if (this.leader === isLeader && this.token === token) return;
    this.leader = isLeader;
    this.token = token;
    for (const l of this.listeners) l(isLeader, token);
  }
}
