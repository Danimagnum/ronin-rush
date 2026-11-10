import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { DataSource } from 'typeorm';
import type { Env } from '../config/env';
import { DATA_SOURCE, ENV, REDIS } from '../config/tokens';
import { appendOutbox } from '../db/outbox';
import { updateReturning, withTransaction } from '../db/tx';
import { RoundRunner } from '../round/round-runner.service';

export const KAFKA_TAP_KEY = 'ronin:kafka:tap';
const BATCH = 200;

interface OutboxRow {
  id: string;
  event_id: string;
  topic: string;
  key: string;
  payload: unknown;
  created_at: Date;
}

/**
 * Transactional-outbox relay: moves rows written alongside ledger/round changes to Kafka.
 * Runs on every instance; `FOR UPDATE SKIP LOCKED` lets them share the work without
 * double-publishing. Delivery is at-least-once, so every message carries a stable event id
 * (a UUID minted with the outbox row) consumers can dedupe on. Messages use the platform envelope. Without KAFKA_BROKERS it runs in dry-run mode: rows are
 * marked and mirrored to the tap only, so the System view still shows the event stream.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('OutboxRelay');
  private producer: Producer | null = null;
  private connected = false;
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private running = false;
  published = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly runner: RoundRunner,
  ) {}

  get mode(): 'kafka' | 'dry-run' {
    return this.env.KAFKA_BROKERS ? 'kafka' : 'dry-run';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.KAFKA_BROKERS) {
      const kafka = new Kafka({
        clientId: this.env.KAFKA_CLIENT_ID,
        brokers: this.env.KAFKA_BROKERS.split(','),
        logLevel: logLevel.WARN,
        retry: { retries: 8 },
      });
      this.producer = kafka.producer({ allowAutoTopicCreation: true, idempotent: true, maxInFlightRequests: 1 });
      void this.producer
        .connect()
        .then(() => {
          this.connected = true;
          this.log.log(`connected to Kafka ${this.env.KAFKA_BROKERS}`);
        })
        .catch((e: Error) => this.log.error(`Kafka unavailable, events stay in the outbox: ${e.message}`));
    } else {
      this.log.log('KAFKA_BROKERS empty: dry-run mode (outbox marked + tapped, nothing sent)');
    }
    this.timer = setInterval(() => void this.tick(), 250);
    if (this.env.PLATFORM_MODE) this.healthTimer = setInterval(() => void this.reportHealth(), 30_000);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.producer?.disconnect().catch(() => undefined);
  }

  /** One relay pass; returns how many events were published. */
  async tick(): Promise<number> {
    if (this.running || (this.producer && !this.connected)) return 0;
    this.running = true;
    try {
      return await withTransaction(this.ds, async (q) => {
        const rows: OutboxRow[] = await q.query(
          `SELECT id, event_id, topic, key, payload, created_at FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [BATCH],
        );
        if (!rows.length) return 0;
        if (this.producer) {
          const byTopic = new Map<string, OutboxRow[]>();
          for (const r of rows) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);
          await this.producer.sendBatch({
            topicMessages: [...byTopic].map(([topic, list]) => ({
              topic,
              messages: list.map((r) => ({
                key: r.key,
                value: JSON.stringify(envelope(r)),
                headers: { 'event-id': r.event_id, 'event-type': r.topic },
              })),
            })),
          });
        }
        await updateReturning(q, `UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
        const tap = this.redis.multi();
        for (const r of rows) {
          tap.lpush(KAFKA_TAP_KEY, JSON.stringify({ eventId: r.event_id, type: r.topic, key: r.key, occurredAt: new Date(r.created_at).toISOString(), mode: this.mode }));
        }
        await tap.ltrim(KAFKA_TAP_KEY, 0, 99).exec();
        this.published += rows.length;
        return rows.length;
      });
    } catch (e) {
      this.log.warn(`relay pass failed (will retry): ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** system.health.reported.v1 (platform contract): status, p95 latency (ms) and error rate (0-1). */
  private async reportHealth(): Promise<void> {
    const redisUp = await this.redis.ping().then(() => true).catch(() => false);
    const loop = this.runner.engine?.metrics().loopLatencyMs;
    const core = this.runner.platform?.core ?? null;
    const errorRate = core && core.calls ? Math.min(1, core.failures / core.calls) : 0;
    await withTransaction(this.ds, (q) =>
      appendOutbox(q, 'system.health.reported.v1', this.env.INSTANCE_ID, {
        service: 'ronin-rush',
        status: !redisUp ? 'unhealthy' : errorRate > 0.05 ? 'degraded' : 'healthy',
        latencyP95: Math.round(Math.max(loop?.p99 ?? 0, core?.p95() ?? 0)),
        errorRate: Math.round(errorRate * 1000) / 1000,
      }),
    ).catch(() => undefined);
  }
}

/**
 * Platform event envelope (@danigil/platform-contracts): stable UUID id, type = topic,
 * version = the topic's numeric suffix, source = service name, correlationId = aggregate.
 */
export function envelope(r: Pick<OutboxRow, 'event_id' | 'topic' | 'key' | 'payload' | 'created_at'>) {
  const version = Number(/\.v(\d+)$/.exec(r.topic)?.[1] ?? 1);
  return {
    id: r.event_id,
    type: r.topic,
    version,
    occurredAt: new Date(r.created_at).toISOString(),
    source: 'ronin-rush',
    correlationId: r.topic.startsWith('ronin.') ? `round-${r.key}` : r.key,
    data: r.payload,
  };
}
