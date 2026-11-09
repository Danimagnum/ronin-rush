import { Controller, Get, Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { SOCKET_EVENTS, type KafkaTapEntry, type LedgerEntryView, type RoundEvent, type SystemMetrics } from '@ronin/shared';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { Clock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, DATA_SOURCE, ENV, REDIS } from '../config/tokens';
import { KAFKA_TAP_KEY, OutboxRelay } from '../events/outbox-relay.service';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';
import { RealtimeGateway } from './realtime.gateway';

const RATE_WINDOW_MS = 10_000;

/**
 * Everything the System view shows, gathered by the leader once a second and pushed to the
 * "system" socket room (only clients with the view open receive it). Cheap by design: counters
 * in memory, one Redis scan for instances, and ledger stats cached for two seconds.
 */
@Injectable()
export class SystemMetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private readonly bets: number[] = [];
  private readonly cashouts: number[] = [];
  private ledgerCache: { at: number; value: SystemMetrics['ledger'] } | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly runner: RoundRunner,
    private readonly hub: EventHub,
    private readonly gateway: RealtimeGateway,
    private readonly relay: OutboxRelay,
  ) {}

  onApplicationBootstrap(): void {
    this.hub.subscribe((e: RoundEvent) => {
      if (e.type === 'bet.placed') this.bets.push(Date.now());
      if (e.type === 'bet.cashed_out') this.cashouts.push(Date.now());
    });
    this.timer = setInterval(() => void this.tick(), 1_000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (!this.runner.isLeader || !this.gateway.io) return;
    const room = this.gateway.io.to('system');
    // Skip the work entirely when nobody has the System view open.
    const listeners = await this.gateway.io.in('system').fetchSockets().catch(() => []);
    if (!listeners.length) return;
    room.emit(SOCKET_EVENTS.systemMetrics, await this.collect());
  }

  async collect(): Promise<SystemMetrics> {
    const now = Date.now();
    const rate = (xs: number[]) => {
      while (xs.length && xs[0]! < now - RATE_WINDOW_MS) xs.shift();
      return Math.round((xs.length / (RATE_WINDOW_MS / 1000)) * 10) / 10;
    };
    const [instances, tapRaw, ledger] = await Promise.all([
      this.gateway.instances(),
      this.redis.lrange(KAFKA_TAP_KEY, 0, 11),
      this.ledgerStats(),
    ]);
    const engine = this.runner.engine.metrics();
    const snap = this.runner.engine.snapshot();
    const recent = tapRaw.map((r) => {
      const e = JSON.parse(r) as KafkaTapEntry;
      return { eventId: e.eventId, type: e.type, key: e.key, occurredAt: e.occurredAt, mode: e.mode };
    });
    return {
      serverTime: this.clock.now(),
      leader: this.env.INSTANCE_ID,
      fencingToken: this.runner.elector.fencingToken,
      round: snap ? { roundId: snap.roundId, phase: snap.phase } : null,
      instances,
      connections: instances.reduce((s, i) => s + i.connections, 0),
      betsPerSecond: rate(this.bets),
      cashoutsPerSecond: rate(this.cashouts),
      loop: {
        lastMs: round2(engine.loopLatencyMs.last),
        p50Ms: round2(engine.loopLatencyMs.p50),
        p99Ms: round2(engine.loopLatencyMs.p99),
        maxMs: round2(engine.loopLatencyMs.max),
        queueDepth: engine.queueDepth,
      },
      drain: { lastMs: this.runner.drain?.lastDrainMs ?? 0, timeouts: this.runner.drain?.timeouts ?? 0 },
      bus: { consumed: this.runner.bus.consumed },
      kafka: { mode: this.relay.mode, published: this.relay.published, recent },
      ledger,
    };
  }

  private async ledgerStats(): Promise<SystemMetrics['ledger']> {
    if (this.ledgerCache && Date.now() - this.ledgerCache.at < 2_000) return this.ledgerCache.value;
    const [[counts], rows] = await Promise.all([
      this.ds.query(
        `SELECT (SELECT COUNT(*) FROM ledger_transactions) AS tx, COUNT(*) AS postings, COALESCE(SUM(amount), 0) AS total FROM postings`,
      ),
      this.ds.query(
        `SELECT p.id, t.type, a.kind, u.username, p.amount, p.created_at
         FROM postings p
         JOIN ledger_transactions t ON t.id = p.transaction_id
         JOIN accounts a ON a.id = p.account_id
         LEFT JOIN users u ON u.id = a.user_id
         ORDER BY p.id DESC LIMIT 10`,
      ),
    ]);
    const recent: LedgerEntryView[] = rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      txType: r.type as LedgerEntryView['txType'],
      account: r.kind === 'user' ? String(r.username) : String(r.kind),
      amount: Number(r.amount),
      at: new Date(r.created_at as string).toISOString(),
    }));
    const value = { transactions: Number(counts.tx), postings: Number(counts.postings), sumOfPostings: Number(counts.total), recent };
    this.ledgerCache = { at: Date.now(), value };
    return value;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Controller('api/system')
export class SystemController {
  constructor(private readonly metrics: SystemMetricsService) {}

  /** Same payload as the socket push, for curl and dashboards. Any instance can answer. */
  @Get()
  get() {
    return this.metrics.collect();
  }
}
