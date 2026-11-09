import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { RoundSnapshot, SettledRoundSummary, type RoundEvent, type ServerHello } from '@ronin/shared';
import type Redis from 'ioredis';
import type { Clock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, ENV, REDIS } from '../config/tokens';
import type { Principal } from '../auth/auth.service';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';
import { PostgresLedger } from '../wallet/postgres-ledger';

const SNAPSHOT_KEY = 'ronin:round:snapshot';
const HISTORY_KEY = 'ronin:round:history';
const HISTORY_SIZE = 50;

/**
 * Redis read model, written by the leader on every round event and readable from any
 * instance: late joiners and REST calls never need to reach the leader.
 */
@Injectable()
export class ReadModel implements OnModuleInit {
  private pendingWrite = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly runner: RoundRunner,
    private readonly hub: EventHub,
    private readonly ledger: PostgresLedger,
  ) {}

  onModuleInit(): void {
    this.hub.subscribe((e) => this.onEvent(e));
  }

  private async onEvent(e: RoundEvent): Promise<void> {
    if (!this.runner.isLeader) return;
    if (e.type === 'round.settled') {
      const summary = this.runner.engine.recentRounds()[0];
      if (summary) await this.redis.multi().lpush(HISTORY_KEY, JSON.stringify(summary)).ltrim(HISTORY_KEY, 0, HISTORY_SIZE - 1).exec();
    }
    if (e.type === 'round.betting' && (await this.redis.llen(HISTORY_KEY)) === 0) {
      const recent = this.runner.engine.recentRounds();
      if (recent.length) await this.redis.rpush(HISTORY_KEY, ...recent.map((r) => JSON.stringify(r)));
    }
    this.scheduleSnapshotWrite();
  }

  /** Coalesces bursts (many bets in one tick) into one write. */
  private scheduleSnapshotWrite(): void {
    if (this.pendingWrite) return;
    this.pendingWrite = true;
    setImmediate(() => {
      this.pendingWrite = false;
      const snap = this.runner.engine.snapshot();
      if (snap) void this.redis.set(SNAPSHOT_KEY, JSON.stringify(snap)).catch(() => undefined);
    });
  }

  async snapshot(): Promise<RoundSnapshot | null> {
    const raw = await this.redis.get(SNAPSHOT_KEY);
    if (!raw) return null;
    return { ...RoundSnapshot.parse(JSON.parse(raw)), serverTime: this.clock.now() };
  }

  async history(): Promise<SettledRoundSummary[]> {
    const raw = await this.redis.lrange(HISTORY_KEY, 0, HISTORY_SIZE - 1);
    return raw.map((r) => SettledRoundSummary.parse(JSON.parse(r)));
  }

  async hello(principal: Principal | null): Promise<ServerHello> {
    const [snapshot, history, balance] = await Promise.all([
      this.snapshot(),
      this.history(),
      principal ? this.ledger.balanceOf(principal.userId).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      instanceId: this.env.INSTANCE_ID,
      serverTime: this.clock.now(),
      snapshot,
      history,
      user: principal && balance !== null ? { id: principal.userId, username: principal.username, balance } : null,
      fairness: { commitment: this.runner.chain.commitment, publicSalt: this.runner.chain.publicSalt },
    };
  }
}
