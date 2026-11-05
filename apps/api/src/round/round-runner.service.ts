import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { formatX100, generateHashChain, type RoundEvent } from '@ronin/shared';
import type Redis from 'ioredis';
import type { ReferenceAlignedClock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, ENV, REDIS } from '../config/tokens';
import { LeaderElector } from '../leader/leader-elector';
import { ChainSeedSource, ImmediateDrainBarrier, InMemoryLedger } from './in-memory';
import { RoundEngine } from './round-engine';

/**
 * Wires leadership to the round loop: the instance holding the Redis lease runs the engine,
 * every other instance stays passive (it will relay commands/events in the real-time milestone).
 *
 * Milestone note: the ledger and seed storage are still in memory here; the Postgres ledger,
 * the persisted chain and round recovery on failover land in the wallet milestone.
 */
@Injectable()
export class RoundRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('RoundRunner');
  readonly elector: LeaderElector;
  readonly engine: RoundEngine;
  readonly ledger = new InMemoryLedger();
  readonly commitment: string;
  readonly chainLength: number;
  private shuttingDown = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) redis: Redis,
    @Inject(CLOCK) clock: ReferenceAlignedClock,
  ) {
    const chain = generateHashChain(env.CHAIN_LENGTH, env.CHAIN_TERMINAL_SEED);
    const seeds = new ChainSeedSource(chain.seeds);
    this.commitment = seeds.commitment;
    this.chainLength = chain.seeds.length;

    this.engine = new RoundEngine({
      clock,
      seeds,
      ledger: this.ledger,
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
    });

    this.elector = new LeaderElector(redis, {
      instanceId: env.INSTANCE_ID,
      ttlMs: env.LEADER_TTL_MS,
      renewEveryMs: env.LEADER_RENEW_MS,
    });
    this.elector.onChange((leader, token) => {
      if (leader) {
        this.log.log(`became leader (fencing token ${token}); starting round loop`);
        this.engine.start();
      } else {
        if (!this.shuttingDown) this.log.warn('lost leadership; stopping round loop');
        this.engine.stop();
      }
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    this.log.log(`hash chain ready: ${this.chainLength} seeds, commitment ${this.commitment}`);
    await this.elector.start();
    if (!this.elector.isLeader) this.log.log('another instance is leader; running as relay');
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.engine.stop();
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
