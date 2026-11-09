import { Controller, Get, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { RoundEvent } from '@ronin/shared';
import type Redis from 'ioredis';
import { REDIS } from '../config/tokens';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const key = (d: string, board: 'best' | 'win') => `ronin:lb:${d}:${board}`;
const NAMES = 'ronin:lb:names';
const BOTS = 'ronin:lb:bots';
const TTL_S = 3 * 24 * 3600;

export interface LeaderboardEntry {
  userId: string;
  username: string;
  isBot: boolean;
  value: number;
}

/** Daily boards in Redis sorted sets: best cash-out multiplier and biggest single win (profit). */
@Injectable()
export class LeaderboardService implements OnModuleInit {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly hub: EventHub,
    private readonly runner: RoundRunner,
  ) {}

  onModuleInit(): void {
    this.hub.subscribe((e) => this.onEvent(e));
  }

  private async onEvent(e: RoundEvent): Promise<void> {
    if (e.type !== 'bet.cashed_out' || !this.runner.isLeader) return;
    const { bet } = e;
    const d = day();
    const m = this.redis.multi();
    m.zadd(key(d, 'best'), 'GT', bet.cashoutX100!, bet.userId);
    m.zadd(key(d, 'win'), 'GT', bet.payout! - bet.amount, bet.userId);
    m.hset(NAMES, bet.userId, bet.username);
    if (bet.isBot) m.sadd(BOTS, bet.userId);
    m.expire(key(d, 'best'), TTL_S).expire(key(d, 'win'), TTL_S);
    await m.exec();
  }

  async top(limit = 10, date = day()) {
    const read = async (board: 'best' | 'win'): Promise<LeaderboardEntry[]> => {
      const flat = await this.redis.zrevrange(key(date, board), 0, limit - 1, 'WITHSCORES');
      const ids = flat.filter((_, i) => i % 2 === 0);
      if (!ids.length) return [];
      const [names, bots] = await Promise.all([this.redis.hmget(NAMES, ...ids), this.redis.smismember(BOTS, ...ids)]);
      return ids.map((userId, i) => ({ userId, username: names[i] ?? '?', isBot: bots[i] === 1, value: Number(flat[i * 2 + 1]) }));
    };
    const [bestMultiplier, biggestWin] = await Promise.all([read('best'), read('win')]);
    return { date, bestMultiplier, biggestWin };
  }
}

@Controller('api/leaderboard')
export class LeaderboardController {
  constructor(private readonly lb: LeaderboardService) {}

  @Get()
  get() {
    return this.lb.top();
  }
}
