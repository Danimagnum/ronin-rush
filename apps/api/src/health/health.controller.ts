import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV, REDIS } from '../config/tokens';
import { HealthService } from '../observability/health.service';
import { MetricsService } from '../observability/metrics.service';
import { renderPrometheus } from '../observability/prometheus';
import { RoundRunner } from '../round/round-runner.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly runner: RoundRunner,
    private readonly health: HealthService,
  ) {}

  /** Legacy summary used by the Docker health check, nginx and the smoke test. */
  @Get()
  async summary() {
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

  /** The process answers: nothing else is checked, so a slow dependency never restarts it. */
  @Get('live')
  live() {
    return { status: 'ok', instanceId: this.env.INSTANCE_ID };
  }

  /** 503 while Postgres or Redis is unreachable; Kafka and Core only degrade (see HealthService). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.check();
    res.status(report.ready ? 200 : 503);
    return { instanceId: this.env.INSTANCE_ID, ...report };
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('cache-control', 'no-store')
  async scrape(): Promise<string> {
    return renderPrometheus(await this.metrics.families());
  }
}
