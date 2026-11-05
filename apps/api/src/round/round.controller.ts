import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../config/env';
import { CLOCK, ENV } from '../config/tokens';
import type { Clock } from '../clock/clock';
import { RoundRunner } from './round-runner.service';

@Controller('api')
export class RoundController {
  constructor(
    private readonly runner: RoundRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Plain HTTP time endpoint; the socket ping/pong (milestone 4) is what clients use for sync. */
  @Get('time')
  time() {
    return { serverTime: this.clock.now() };
  }

  @Get('round')
  round() {
    const snap = this.runner.engine.snapshot();
    if (!this.runner.elector.isLeader || !snap) {
      throw new ServiceUnavailableException('NOT_LEADER: round state is served by the leader until the Redis read model lands');
    }
    return snap;
  }

  @Get('fairness')
  fairness() {
    return {
      commitment: this.runner.commitment,
      publicSalt: this.env.PUBLIC_SALT,
      chainLength: this.runner.chainLength,
      growthPerMs: this.env.GROWTH_K,
      formula: 'crash = max(1.00, floor(99 / (1 - h/2^52)) / 100), h = first 52 bits of HMAC-SHA256(seed, salt)',
      recentRounds: this.runner.engine.recentRounds(),
    };
  }
}
