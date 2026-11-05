import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV, REDIS } from '../config/tokens';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) => {
        const log = new Logger('Redis');
        const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableReadyCheck: true });
        client.on('error', (e) => log.warn(e.message));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
