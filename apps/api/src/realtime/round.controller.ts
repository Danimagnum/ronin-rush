import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Clock } from '../clock/clock';
import { CLOCK } from '../config/tokens';
import { RoundRunner } from '../round/round-runner.service';
import { ReadModel } from './read-model.service';

/** Served by every instance from the Redis read model. */
@Controller('api')
export class RoundController {
  constructor(
    private readonly runner: RoundRunner,
    private readonly readModel: ReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Plain HTTP time; clients sync over the socket ping/pong, which has lower and steadier RTT. */
  @Get('time')
  time() {
    return { serverTime: this.clock.now() };
  }

  @Get('round')
  async round() {
    const snap = await this.readModel.snapshot();
    if (!snap) throw new ServiceUnavailableException('no round yet');
    return snap;
  }

  @Get('rounds/recent')
  recent() {
    return this.readModel.history();
  }

  @Get('fairness')
  async fairness() {
    return {
      commitment: this.runner.chain.commitment,
      publicSalt: this.runner.chain.publicSalt,
      chainLength: this.runner.chain.length,
      hash: 'seed_i = SHA256(seed_{i+1}); commitment = SHA256(seed_1); round r uses seed_r',
      formula: 'crash = max(1.00, floor(99 / (1 - h/2^52)) / 100), h = first 52 bits of HMAC-SHA256(key=seed, msg=publicSalt)',
      recentRounds: await this.readModel.history(),
    };
  }
}
