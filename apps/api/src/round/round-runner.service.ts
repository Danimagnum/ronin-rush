import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { formatX100, type RoundEvent } from '@ronin/shared';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { ReferenceAlignedClock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, DATA_SOURCE, ENV, REDIS } from '../config/tokens';
import { currentFence } from '../db/fence';
import { LeaderElector } from '../leader/leader-elector';
import { PostgresLedger } from '../wallet/postgres-ledger';
import { ImmediateDrainBarrier } from './in-memory';
import { PostgresRoundStore } from './postgres-round-store';
import { PostgresSeedSource, ensureActiveChain, type ActiveChain } from './postgres-seed-source';
import { RoundEngine } from './round-engine';

/**
 * Wires leadership to the round loop: the instance holding the Redis lease runs the engine,
 * every other instance stays passive (it relays commands/events in the real-time milestone).
 * On takeover the engine resumes whatever round the database says is in progress.
 */
@Injectable()
export class RoundRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('RoundRunner');
  readonly elector: LeaderElector;
  engine!: RoundEngine;
  chain!: ActiveChain;
  private shuttingDown = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) redis: Redis,
    @Inject(CLOCK) private readonly clock: ReferenceAlignedClock,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly ledger: PostgresLedger,
  ) {
    this.elector = new LeaderElector(redis, {
      instanceId: env.INSTANCE_ID,
      ttlMs: env.LEADER_TTL_MS,
      renewEveryMs: env.LEADER_RENEW_MS,
      minToken: () => currentFence(this.ds),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const { env } = this;
    this.chain = await ensureActiveChain(this.ds, {
      length: env.CHAIN_LENGTH,
      publicSalt: env.PUBLIC_SALT,
      terminalSeed: env.CHAIN_TERMINAL_SEED,
    });
    this.log.log(
      `${this.chain.created ? 'generated' : 'loaded'} hash chain #${this.chain.chainId}: ${this.chain.length} seeds, commitment ${this.chain.commitment}`,
    );

    this.engine = new RoundEngine({
      clock: this.clock,
      seeds: new PostgresSeedSource(this.ds, this.chain),
      ledger: this.ledger,
      store: new PostgresRoundStore(this.ds, this.chain.chainId),
      drain: new ImmediateDrainBarrier(),
      events: { emit: (e) => this.logEvent(e) },
      config: {
        bettingMs: env.BETTING_MS,
        resultMs: env.RESULT_MS,
        drainTimeoutMs: env.DRAIN_TIMEOUT_MS,
        k: env.GROWTH_K,
        publicSalt: env.PUBLIC_SALT,
        minBetCents: 10,
        maxBetCents: 1_000_000,
      },
      onError: (e) => this.log.error(e instanceof Error ? e.stack : String(e)),
      onFenced: () => this.log.error('fenced out by a newer leader; round loop stopped'),
      onResume: ({ roundId, phase }) => this.log.log(`resumed round #${roundId} in phase ${phase}`),
    });

    this.elector.onChange((leader, token) => {
      if (leader) {
        this.log.log(`became leader (fencing token ${token}); starting round loop`);
        this.engine.start(token!);
      } else {
        if (!this.shuttingDown) this.log.warn('lost leadership; stopping round loop');
        this.engine.stop();
      }
    });
    await this.elector.start();
    if (!this.elector.isLeader) this.log.log('another instance is leader; running as relay');
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.engine?.stop();
    await this.engine?.idle();
    this.log.log('shutting down: releasing leadership');
    await this.elector.stop();
  }

  private logEvent(e: RoundEvent): void {
    switch (e.type) {
      case 'round.betting':
        this.log.log(`#${e.roundId} BETTING  hash ${e.seedHash.slice(0, 16)}…`);
        break;
      case 'round.started':
        this.log.log(`#${e.roundId} RUNNING`);
        break;
      case 'round.crashed':
        this.log.log(`#${e.roundId} DEFEATED x${formatX100(e.crashX100)}`);
        break;
      case 'round.settled':
        this.log.log(`#${e.roundId} SETTLED  seed ${e.seed.slice(0, 16)}…`);
        break;
      default:
        this.log.debug(e.type);
    }
  }
}
