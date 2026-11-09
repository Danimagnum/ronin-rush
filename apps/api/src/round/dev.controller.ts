import { Body, Controller, ForbiddenException, Inject, Post } from '@nestjs/common';
import { CashoutCommand, PlaceBetCommand } from '@ronin/shared';
import type { Env } from '../config/env';
import { CLOCK, ENV } from '../config/tokens';
import type { Clock } from '../clock/clock';
import { PostgresLedger } from '../wallet/postgres-ledger';
import { RoundRunner } from './round-runner.service';

/**
 * Development-only HTTP shortcuts to drive the engine with curl until the Socket.IO gateway
 * and auth land (real-time milestone). Disabled when NODE_ENV=production.
 */
@Controller('api/dev')
export class DevController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: RoundRunner,
    private readonly ledger: PostgresLedger,
  ) {}

  private guard() {
    if (this.env.NODE_ENV === 'production') throw new ForbiddenException();
  }

  @Post('users')
  async createUser(@Body() body: { username: string }) {
    this.guard();
    return this.ledger.createUser({ username: body.username, grantCents: this.env.SIGNUP_GRANT_CENTS });
  }

  @Post('bet')
  async bet(@Body() body: { userId: string; username: string } & PlaceBetCommand) {
    const receivedAt = this.clock.now(); // stamp first, then validate
    this.guard();
    const cmd = PlaceBetCommand.parse(body);
    return this.runner.engine.placeBet({ ...cmd, userId: body.userId, username: body.username, receivedAt });
  }

  @Post('cashout')
  async cashout(@Body() body: { userId: string } & CashoutCommand) {
    const receivedAt = this.clock.now();
    this.guard();
    const cmd = CashoutCommand.parse(body);
    return this.runner.engine.cashOut({ ...cmd, userId: body.userId, receivedAt });
  }
}
