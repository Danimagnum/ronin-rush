import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { RoundEvent } from '@ronin/shared';
import type { Clock, ClockSyncReport } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, ENV } from '../config/tokens';
import { OutboxRelay } from '../events/outbox-relay.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';
import { HealthService } from './health.service';
import { HttpMetrics, type MetricFamily } from './prometheus';

const RATE_WINDOW_MS = 10_000;

/**
 * Game metrics for Prometheus. Every instance sees every round event, so bet and cash-out
 * counters only move on the leader: summing them across replicas gives the true total, and
 * the per-instance series of followers stay flat instead of multiplying the count.
 */
@Injectable()
export class MetricsService implements OnApplicationBootstrap {
  private bets = 0;
  private cashouts = 0;
  private readonly recentBets: number[] = [];
  private readonly recentCashouts: number[] = [];

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: RoundRunner,
    private readonly hub: EventHub,
    private readonly gateway: RealtimeGateway,
    private readonly relay: OutboxRelay,
    private readonly health: HealthService,
    private readonly http: HttpMetrics,
  ) {}

  onApplicationBootstrap(): void {
    this.hub.subscribe((e: RoundEvent) => this.onEvent(e));
  }

  /** Exposed for tests. */
  onEvent(e: RoundEvent, leader = this.runner.isLeader, now = Date.now()): void {
    if (!leader) return;
    if (e.type === 'bet.placed') {
      this.bets++;
      this.recentBets.push(now);
    } else if (e.type === 'bet.cashed_out') {
      this.cashouts++;
      this.recentCashouts.push(now);
    }
  }

  async families(now = Date.now()): Promise<MetricFamily[]> {
    const leader = this.runner.isLeader;
    const rate = (xs: number[]) => {
      while (xs.length && xs[0]! < now - RATE_WINDOW_MS) xs.shift();
      return xs.length / (RATE_WINDOW_MS / 1000);
    };
    const loop = this.runner.engine?.metrics();
    const sync = (this.clock as Partial<{ lastSync: ClockSyncReport | null }>).lastSync ?? null;
    const [backlog, report] = await Promise.all([this.relay.backlog().catch(() => null), this.health.check()]);
    const platform = this.runner.platform;
    const g = (name: string, help: string, value: number, labels?: Record<string, string>): MetricFamily => ({
      name,
      help,
      type: 'gauge',
      samples: [{ labels, value }],
    });
    const c = (name: string, help: string, value: number): MetricFamily => ({ name, help, type: 'counter', samples: [{ value }] });

    const families: MetricFamily[] = [
      g('ronin_build_info', 'Build and instance identity.', 1, { service: this.env.SERVICE_NAME, version: process.env.RONIN_TAG ?? 'dev', instance_id: this.env.INSTANCE_ID }),
      g('ronin_leader', '1 when this instance runs the round loop.', leader ? 1 : 0),
      {
        name: 'ronin_health_status',
        help: 'Current health status (1 for the active one).',
        type: 'gauge',
        samples: (['healthy', 'degraded', 'unhealthy'] as const).map((s) => ({ labels: { status: s }, value: report.status === s ? 1 : 0 })),
      },
      {
        name: 'ronin_round_loop_latency_seconds',
        help: 'Round-loop decision latency on the leader (recent quantiles).',
        type: 'gauge',
        samples: leader && loop
          ? [
              { labels: { quantile: '0.5' }, value: loop.loopLatencyMs.p50 / 1000 },
              { labels: { quantile: '0.99' }, value: loop.loopLatencyMs.p99 / 1000 },
              { labels: { quantile: '1' }, value: loop.loopLatencyMs.max / 1000 },
            ]
          : [],
      },
      g('ronin_round_loop_queue_depth', 'Commands waiting in the leader decision queue.', leader && loop ? loop.queueDepth : 0),
      c('ronin_bets_total', 'Bets accepted (counted on the leader only).', this.bets),
      c('ronin_cashouts_total', 'Cash-outs paid, manual and automatic (leader only).', this.cashouts),
      g('ronin_bets_per_second', 'Bets per second over the last 10 s (leader only).', rate(this.recentBets)),
      g('ronin_cashouts_per_second', 'Cash-outs per second over the last 10 s (leader only).', rate(this.recentCashouts)),
      g('ronin_socket_connections', 'Socket.IO connections on this instance.', this.gateway.localConnections),
      g('ronin_clock_offset_seconds', 'Offset of this instance clock to the shared Redis TIME reference.', (sync?.offsetMs ?? 0) / 1000),
      g('ronin_clock_rtt_seconds', 'Round trip of the last clock synchronisation.', (sync?.rttMs ?? 0) / 1000),
      g('ronin_outbox_pending', 'Events waiting in the outbox (not yet published, not rejected).', backlog?.pending ?? -1),
      g('ronin_outbox_lag_seconds', 'Age of the oldest event waiting in the outbox.', backlog?.oldestSeconds ?? -1),
      c('ronin_outbox_published_total', 'Events published by this instance relay (Kafka or dry-run).', this.relay.published),
      c('ronin_outbox_rejected_total', 'Events set aside by this instance relay for breaking the event contract.', this.relay.rejected),
      g('ronin_kafka_connected', '1 when the relay producer is connected (always 0 in dry-run).', this.relay.kafkaConnected ? 1 : 0),
    ];
    if (platform) {
      const core = report.checks.core;
      families.push(
        g('ronin_platform_pending_settlements', 'Core captures not yet confirmed.', core?.pendingSettlements ?? -1),
        g('ronin_platform_oldest_settlement_seconds', 'Age of the oldest unconfirmed Core capture.', core?.oldestPendingSeconds ?? -1),
        c('ronin_platform_settlements_total', 'Core captures confirmed by this instance.', platform.settled),
        c('ronin_core_requests_total', 'Calls to platform-core from this instance.', platform.core.calls),
        c('ronin_core_failures_total', 'Calls to platform-core that failed after retries.', platform.core.failures),
        g('ronin_core_latency_p95_seconds', 'p95 latency of recent platform-core calls.', platform.core.p95() / 1000),
      );
    }
    return [...families, ...this.http.families()];
  }
}
