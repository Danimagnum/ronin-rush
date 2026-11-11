import type { RoundEvent } from '@ronin/shared';
import Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import type { OutboxRelay } from '../src/events/outbox-relay.service';
import { decideStatus, HealthService } from '../src/observability/health.service';
import { MetricsService } from '../src/observability/metrics.service';
import { HttpMetrics, renderPrometheus } from '../src/observability/prometheus';
import type { RoundRunner } from '../src/round/round-runner.service';
import { TEST_DATABASE_URL, freshSchema } from './db';

const REDIS_URL = process.env.REDIS_URL;

describe('Prometheus exposition', () => {
  it('renders HELP/TYPE headers, escaped labels and special values', () => {
    const text = renderPrometheus([
      { name: 'x_total', help: 'A counter.', type: 'counter', samples: [{ labels: { route: '/a"b', le: '+Inf' }, value: 3 }] },
      { name: 'y', help: 'A gauge.', type: 'gauge', samples: [{ value: Infinity }] },
    ]);
    expect(text).toBe('# HELP x_total A counter.\n# TYPE x_total counter\nx_total{route="/a\\"b",le="+Inf"} 3\n# HELP y A gauge.\n# TYPE y gauge\ny +Inf\n');
  });

  it('HTTP histogram buckets are cumulative and the 60 s window drives the health numbers', () => {
    const m = new HttpMetrics();
    const t0 = 1_000_000;
    m.record('GET', '/api/round', 200, 3, t0); // 0.003 s
    m.record('GET', '/api/round', 200, 40, t0); // 0.04 s
    m.record('POST', '/api/auth/guest', 500, 120, t0);
    const text = renderPrometheus(m.families());
    expect(text).toContain('http_requests_total{method="GET",route="/api/round",status_code="200"} 2');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/round",status_code="200",le="0.005"} 1');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/round",status_code="200",le="0.05"} 2');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/api/round",status_code="200",le="+Inf"} 2');
    expect(m.windowStats(t0)).toEqual({ latencyP95: 120, errorRate: 0.333, requests: 3 });
    expect(m.windowStats(t0 + 61_000)).toEqual({ latencyP95: 0, errorRate: 0, requests: 0 });
  });
});

describe('health status decision', () => {
  const base = {
    checks: { postgres: { ok: true }, redis: { ok: true }, kafka: { ok: true, mode: 'kafka' as const }, core: null },
    http: { latencyP95: 5, errorRate: 0, requests: 10 },
  };
  it('hard dependencies make it unhealthy; Kafka, Core and HTTP errors only degrade it', () => {
    expect(decideStatus(base)).toBe('healthy');
    expect(decideStatus({ ...base, checks: { ...base.checks, postgres: { ok: false } } })).toBe('unhealthy');
    expect(decideStatus({ ...base, checks: { ...base.checks, redis: { ok: false } } })).toBe('unhealthy');
    expect(decideStatus({ ...base, checks: { ...base.checks, kafka: { ok: false, mode: 'kafka' } } })).toBe('degraded');
    expect(decideStatus({ ...base, checks: { ...base.checks, kafka: { ok: false, mode: 'dry-run' } } })).toBe('healthy');
    expect(decideStatus({ ...base, checks: { ...base.checks, core: { ok: false, pendingSettlements: 3, oldestPendingSeconds: 90 } } })).toBe('degraded');
    expect(decideStatus({ ...base, http: { latencyP95: 5, errorRate: 0.2, requests: 10 } })).toBe('degraded');
  });
});

describe('game metrics', () => {
  it('counts bets and cash-outs on the leader only, so summing replicas gives the true total', async () => {
    const svc = new MetricsService(
      loadEnv({}),
      { now: () => 0 },
      {} as RoundRunner,
      { subscribe: () => () => {} } as never,
      {} as never,
      {} as never,
      {} as never,
      new HttpMetrics(),
    );
    const placed = { type: 'bet.placed' } as RoundEvent;
    const cashed = { type: 'bet.cashed_out' } as RoundEvent;
    svc.onEvent(placed, true, 1_000);
    svc.onEvent(placed, true, 1_000);
    svc.onEvent(cashed, true, 1_000);
    svc.onEvent(placed, false, 1_000); // a follower sees the same event: not counted
    expect((svc as unknown as { bets: number }).bets).toBe(2);
    expect((svc as unknown as { cashouts: number }).cashouts).toBe(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('HealthService (real PostgreSQL + Redis)', () => {
  let ds: DataSource;
  let redis: Redis;
  const relay = { mode: 'kafka', kafkaConnected: true } as unknown as OutboxRelay & { kafkaConnected: boolean };
  let health: HealthService;

  beforeAll(async () => {
    ds = await freshSchema('t_health');
    redis = new Redis(REDIS_URL!, { db: 12 });
    health = new HealthService(loadEnv({ SERVICE_NAME: 'ronin-rush', INSTANCE_ID: 'api-1' }), ds, redis, { platform: null } as unknown as RoundRunner, relay, new HttpMetrics());
  });
  afterAll(async () => {
    redis?.disconnect();
    await ds?.destroy();
  });

  const reports = async () =>
    (await ds.query(`SELECT payload FROM outbox WHERE topic = 'system.health.reported.v1' ORDER BY id`)).map((r: { payload: { status: string } }) => r.payload.status);

  it('reports on start, on every status change, and otherwise only every 30 s', async () => {
    const t = 10_000_000;
    expect((await health.evaluate(t)).status).toBe('healthy');
    await health.evaluate(t + 5_000); // unchanged, not due
    expect(await reports()).toEqual(['healthy']);

    relay.kafkaConnected = false; // broker lost
    expect((await health.evaluate(t + 10_000)).status).toBe('degraded');
    expect(await reports()).toEqual(['healthy', 'degraded']); // immediately, not at the next 30 s tick

    relay.kafkaConnected = true;
    await health.evaluate(t + 15_000);
    await health.evaluate(t + 20_000);
    expect(await reports()).toEqual(['healthy', 'degraded', 'healthy']);
    await health.evaluate(t + 50_000); // 35 s after the last report: periodic report
    expect(await reports()).toEqual(['healthy', 'degraded', 'healthy', 'healthy']);
  });

  it('readiness depends on Postgres and Redis only', async () => {
    relay.kafkaConnected = false;
    const r = await health.check();
    expect(r).toMatchObject({ status: 'degraded', ready: true });
    relay.kafkaConnected = true;
  });
});
