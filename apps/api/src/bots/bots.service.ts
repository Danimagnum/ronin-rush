import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { elapsedMsForX100, type RoundEvent } from '@ronin/shared';
import type { DataSource } from 'typeorm';
import type { Clock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, DATA_SOURCE, ENV } from '../config/tokens';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';
import { PostgresLedger } from '../wallet/postgres-ledger';

const NAMES = [
  'shiro', 'kaze', 'hotaru', 'tetsu', 'yukinoshita', 'raiden_x', 'momiji', 'sora', 'kumo', 'haru',
  'ishi', 'take', 'akane', 'jin', 'mizu', 'ren_ga', 'tora', 'hayate', 'kiri', 'nagi',
];
const STAKES = [100, 200, 500, 500, 1_000, 1_000, 2_000, 5_000, 10_000];
const BOT_GRANT = 1_000_000;

interface Bot {
  userId: string;
  username: string;
}

/**
 * Simulated players so the live list is never empty. They run on the leader only and go
 * through exactly the same engine paths as humans (bets, auto cash-outs, manual cash-outs
 * stamped with server time), so they also exercise the ledger continuously.
 */
@Injectable()
export class BotsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Bots');
  private bots: Bot[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly manualTargets = new Map<string, number>(); // userId -> target x100 for this round
  private roundsSinceRefill = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly ledger: PostgresLedger,
    private readonly runner: RoundRunner,
    private readonly hub: EventHub,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.BOTS_COUNT === 0) return;
    this.bots = [];
    for (const username of NAMES.slice(0, this.env.BOTS_COUNT)) this.bots.push(await this.ensureBot(username));
    this.hub.subscribe((e) => this.onEvent(e));
    this.log.log(`${this.bots.length} bots ready`);
  }

  onModuleDestroy(): void {
    this.clearTimers();
  }

  private async ensureBot(username: string): Promise<Bot> {
    const [row] = await this.ds.query(`SELECT id FROM users WHERE username = $1`, [username]);
    if (row) return { userId: row.id, username };
    try {
      const u = await this.ledger.createUser({ username, isBot: true, grantCents: BOT_GRANT });
      return { userId: u.userId, username };
    } catch {
      const [again] = await this.ds.query(`SELECT id FROM users WHERE username = $1`, [username]); // another instance won the race
      return { userId: again.id, username };
    }
  }

  private onEvent(e: RoundEvent): void {
    if (!this.runner.isLeader) return;
    if (e.type === 'round.betting') this.planBets(e.roundId, e.bettingEndsAt);
    if (e.type === 'round.started') this.planCashouts(e.roundId, e.startedAt, e.k);
    if (e.type === 'round.crashed') this.clearTimers();
    if (e.type === 'round.settled' && ++this.roundsSinceRefill >= 10) {
      this.roundsSinceRefill = 0;
      void this.refill();
    }
  }

  private planBets(roundId: number, bettingEndsAt: number): void {
    this.manualTargets.clear();
    const window = Math.max(0, bettingEndsAt - this.clock.now() - 300);
    for (const bot of this.bots) {
      if (Math.random() > 0.7) continue; // sit this round out
      const amount = STAKES[Math.floor(Math.random() * STAKES.length)]!;
      const target = this.randomTarget();
      const useAuto = Math.random() < 0.45;
      this.later(Math.random() * window, async () => {
        const res = await this.runner.engine.placeBet({
          userId: bot.userId,
          username: bot.username,
          isBot: true,
          amount,
          autoX100: useAuto ? target : null,
          idempotencyKey: `bot-${roundId}-${bot.userId}`,
          receivedAt: this.clock.now(),
        });
        if (res.ok && !useAuto) this.manualTargets.set(bot.userId, target);
      });
    }
  }

  private planCashouts(roundId: number, startedAt: number, k: number): void {
    for (const [userId, target] of this.manualTargets) {
      // Humans hesitate: aim at the target with a little reaction-time jitter.
      const at = startedAt + elapsedMsForX100(target, k) + (Math.random() * 300 - 100);
      this.later(at - this.clock.now(), () =>
        this.runner.engine
          .cashOut({ userId, roundId, idempotencyKey: `bot-co-${roundId}-${userId}`, receivedAt: this.clock.now() })
          .then(() => undefined),
      );
    }
  }

  /** Heavy-tailed: mostly 1.2x–3x, occasionally greedy. */
  private randomTarget(): number {
    const u = Math.random();
    return Math.min(5_000, Math.max(110, Math.floor(105 / (1 - u * 0.9))));
  }

  private async refill(): Promise<void> {
    for (const bot of this.bots) {
      const balance = await this.ledger.balanceOf(bot.userId).catch(() => BOT_GRANT);
      if (balance < BOT_GRANT / 10) await this.ledger.grant(bot.userId, BOT_GRANT, `grant:bot:${bot.userId}:${Date.now()}`);
    }
  }

  private later(ms: number, fn: () => Promise<void>): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn().catch(() => undefined);
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
