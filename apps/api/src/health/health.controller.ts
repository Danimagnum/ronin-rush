import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV, REDIS } from '../config/tokens';
import { RoundRunner } from '../round/round-runner.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly runner: RoundRunner,
  ) {}

  @Get()
  async health() {
    const redis = await this.redis.ping().then(() => 'up').catch(() => 'down');
    return {
      status: redis === 'up' ? 'ok' : 'degraded',
      instanceId: this.env.INSTANCE_ID,
      leader: this.runner.isLeader,
      fencingToken: this.runner.elector.fencingToken,
      redis,
      engine: this.runner.engine?.metrics() ?? null,
    };
  }
}
