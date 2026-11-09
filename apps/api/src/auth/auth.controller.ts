import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, Post, Query } from '@nestjs/common';

const tooMany = (msg: string) => new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { Env } from '../config/env';
import { DATA_SOURCE, ENV, REDIS } from '../config/tokens';
import { PostgresLedger } from '../wallet/postgres-ledger';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: unknown) {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.login(body);
  }

  @Post('guest')
  guest() {
    return this.auth.guest();
  }
}

@Controller('api/me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly ledger: PostgresLedger,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  async me(@Headers('authorization') authorization?: string) {
    const p = await this.auth.require(authorization);
    return { id: p.userId, username: p.username, balance: await this.ledger.balanceOf(p.userId) };
  }

  /** "My bets": newest first, with the round's crash point once it is public. */
  @Get('bets')
  async bets(@Headers('authorization') authorization?: string, @Query('limit') limit = '50') {
    const p = await this.auth.require(authorization);
    const rows = await this.ds.query(
      `SELECT b.id, b.round_id, b.amount, b.auto_x100, b.status, b.cashout_x100, b.payout, b.auto_cashout, b.created_at,
              CASE WHEN r.phase IN ('CRASHED', 'SETTLED') THEN r.crash_x100 END AS crash_x100
       FROM bets b JOIN rounds r ON r.id = b.round_id
       WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT $2`,
      [p.userId, Math.min(200, Math.max(1, Number(limit) || 50))],
    );
    return rows.map((r: Record<string, unknown>) => ({
      betId: r.id,
      roundId: Number(r.round_id),
      amount: Number(r.amount),
      autoX100: r.auto_x100,
      status: r.status,
      cashoutX100: r.cashout_x100,
      payout: r.payout === null ? null : Number(r.payout),
      autoCashout: r.auto_cashout,
      crashX100: r.crash_x100 === null ? null : Number(r.crash_x100),
      createdAt: r.created_at,
    }));
  }

  /** Play-money top-up, allowed once every 10 minutes when the balance is low. */
  @Post('refill')
  async refill(@Headers('authorization') authorization?: string) {
    const p = await this.auth.require(authorization);
    const balance = await this.ledger.balanceOf(p.userId);
    if (balance >= this.env.SIGNUP_GRANT_CENTS / 10) throw tooMany('balance is not low');
    const slot = Math.floor(Date.now() / 600_000);
    const ok = await this.redis.set(`ronin:refill:${p.userId}:${slot}`, '1', 'EX', 600, 'NX');
    if (!ok) throw tooMany('one refill per 10 minutes');
    return { balance: await this.ledger.grant(p.userId, this.env.SIGNUP_GRANT_CENTS, `grant:refill:${p.userId}:${slot}`) };
  }
}
