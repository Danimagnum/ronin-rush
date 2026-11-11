import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { Env } from '../config/env';
import { DATA_SOURCE, ENV, REDIS } from '../config/tokens';
import { appendOutbox } from '../db/outbox';
import { withTransaction } from '../db/tx';
import { OutboxRelay } from '../events/outbox-relay.service';
import { RoundRunner } from '../round/round-runner.service';
import { HttpMetrics } from './prometheus';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface Check {
  ok: boolean;
  ms?: number;
  detail?: string;
}

export interface HealthReport {
  status: HealthStatus;
  /** Postgres and Redis: without them no round can run, so /health/ready answers 503. */
  ready: boolean;
  checks: {
    postgres: Check;
    redis: Check;
    kafka: Check & { mode: 'kafka' | 'dry-run' };
    core: (Check & { pendingSettlements: number; oldestPendingSeconds: number }) | null;
  };
  http: { latencyP95: number; errorRate: number; requests: number };
}

/** A settlement older than this means Core is not accepting captures: degraded, not down. */
export const SETTLEMENT_STALE_SECONDS = 60;
export const HTTP_ERROR_RATE_DEGRADED = 0.05;
const CHECK_TIMEOUT_MS = 2_000;
const EVALUATE_EVERY_MS = 5_000;
const REPORT_EVERY_MS = 30_000;

function timed<T>(p: Promise<T>): Promise<Check> {
  const started = Date.now();
  return Promise.race([
    p.then(() => ({ ok: true, ms: Date.now() - started })),
    new Promise<Check>((r) => setTimeout(() => r({ ok: false, detail: `no answer in ${CHECK_TIMEOUT_MS} ms` }), CHECK_TIMEOUT_MS)),
  ]).catch((e: Error) => ({ ok: false, detail: e.message }));
}

/** Pure decision, unit-tested: hard dependencies make it unhealthy, soft ones degraded. */
export function decideStatus(r: Omit<HealthReport, 'status' | 'ready'>): HealthStatus {
  if (!r.checks.postgres.ok || !r.checks.redis.ok) return 'unhealthy';
  if (r.checks.kafka.mode === 'kafka' && !r.checks.kafka.ok) return 'degraded';
  if (r.checks.core && !r.checks.core.ok) return 'degraded';
  if (r.http.errorRate > HTTP_ERROR_RATE_DEGRADED) return 'degraded';
  return 'healthy';
}

/**
 * Liveness, readiness and the platform health event. Kafka and Core are soft dependencies:
 * the outbox and the settlement queue hold their work until they are back, so their failure
 * degrades the service but never takes it out of rotation. system.health.reported.v1 goes out
 * every 30 s and immediately on every status change (through the outbox, like every event).
 */
@Injectable()
export class HealthService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Health');
  private timer: NodeJS.Timeout | null = null;
  private lastStatus: HealthStatus | null = null;
  private lastReportAt = 0;
  reportsSent = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly runner: RoundRunner,
    private readonly relay: OutboxRelay,
    private readonly http: HttpMetrics,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.evaluate(), EVALUATE_EVERY_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<HealthReport> {
    const [postgres, redis, core] = await Promise.all([
      timed(this.ds.query('SELECT 1')),
      timed(this.redis.ping()),
      this.coreCheck(),
    ]);
    const kafka = { mode: this.relay.mode, ok: this.relay.mode === 'dry-run' || this.relay.kafkaConnected };
    const partial = { checks: { postgres, redis, kafka, core }, http: this.http.windowStats() };
    const status = decideStatus(partial);
    return { status, ready: postgres.ok && redis.ok, ...partial };
  }

  /** One evaluation; reports when the status changed or the periodic report is due. */
  async evaluate(now = Date.now()): Promise<HealthReport> {
    const report = await this.check();
    const changed = report.status !== this.lastStatus;
    if (changed && this.lastStatus !== null) this.log.warn(`health ${this.lastStatus} → ${report.status}`);
    if (changed || now - this.lastReportAt >= REPORT_EVERY_MS) {
      const sent = await this.publish(report);
      if (sent) {
        this.lastStatus = report.status;
        this.lastReportAt = now;
      }
    }
    return report;
  }

  private async publish(report: HealthReport): Promise<boolean> {
    try {
      await withTransaction(this.ds, (q) =>
        appendOutbox(q, 'system.health.reported.v1', this.env.INSTANCE_ID, {
          service: this.env.SERVICE_NAME,
          status: report.status,
          latencyP95: report.http.latencyP95,
          errorRate: report.http.errorRate,
        }),
      );
      this.reportsSent++;
      return true;
    } catch {
      // Postgres down: the event cannot be stored (the outbox lives there). Evaluation retries
      // every 5 s; the first report after recovery carries the then-current status.
      return false;
    }
  }

  private async coreCheck(): Promise<HealthReport['checks']['core']> {
    const platform = this.runner.platform;
    if (!platform) return null;
    try {
      const [row] = await this.ds.query(
        `SELECT COUNT(*)::int AS n, COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at)), 0)::float AS oldest
         FROM platform_settlements WHERE status = 'PENDING'`,
      );
      const oldest = Math.round(Number(row.oldest));
      return {
        ok: oldest <= SETTLEMENT_STALE_SECONDS,
        pendingSettlements: row.n,
        oldestPendingSeconds: oldest,
        detail: oldest > SETTLEMENT_STALE_SECONDS ? `settlement pending for ${oldest} s: Core not accepting captures` : undefined,
      };
    } catch (e) {
      return { ok: false, pendingSettlements: -1, oldestPendingSeconds: -1, detail: (e as Error).message };
    }
  }
}
