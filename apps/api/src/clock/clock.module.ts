import { Global, Inject, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Env } from '../config/env';
import { CLOCK, ENV, REDIS } from '../config/tokens';
import { ReferenceAlignedClock } from './clock';

/** Redis TIME is the shared reference: every API instance stamps commands on the same timeline. */
export function redisTimeMs(redis: Redis): () => Promise<number> {
  return async () => {
    const [s, us] = await redis.time();
    return Number(s) * 1000 + Number(us) / 1000;
  };
}

@Global()
@Module({
  providers: [
    { provide: CLOCK, inject: [REDIS], useFactory: (redis: Redis) => new ReferenceAlignedClock(redisTimeMs(redis)) },
  ],
  exports: [CLOCK],
})
export class ClockModule implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Clock');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CLOCK) private readonly clock: ReferenceAlignedClock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    const r = await this.clock.sync();
    this.log.log(`aligned to Redis TIME: offset ${r.offsetMs.toFixed(2)} ms, rtt ${r.rttMs.toFixed(2)} ms`);
    this.timer = setInterval(() => {
      this.clock.sync().catch((e: Error) => this.log.warn(`clock sync failed: ${e.message}`));
    }, this.env.CLOCK_SYNC_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
