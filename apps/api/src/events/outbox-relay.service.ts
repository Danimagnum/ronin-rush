import { isEventType, parseEvent } from '@danigil/platform-contracts';
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
 * (a UUID minted with the outbox row) consumers can dedupe on. Every event is wrapped in the
 * platform envelope and validated with @danigil/platform-contracts before it leaves; one that
 * does not match its published schema is set aside (rejected_at + reason), never sent and never
 * allowed to block the queue. Without KAFKA_BROKERS it runs in dry-run mode: rows are validated,
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
  rejected = 0;

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
          `SELECT id, event_id, topic, key, payload, created_at FROM outbox
           WHERE published_at IS NULL AND rejected_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [BATCH],
        );
        if (!rows.length) return 0;
        const valid: { row: OutboxRow; event: unknown; correlationId: string }[] = [];
        const bad: { id: string; reason: string }[] = [];
        for (const row of rows) {
          const v = validateOutboxRow(row, this.env.SERVICE_NAME);
          if (v.ok) valid.push({ row, event: v.event, correlationId: v.correlationId });
          else bad.push({ id: row.id, reason: v.reason });
        }
        if (bad.length) {
          await q.query(
            `UPDATE outbox SET rejected_at = now(), reject_reason = x.reason
             FROM unnest($1::bigint[], $2::text[]) AS x(id, reason) WHERE outbox.id = x.id`,
            [bad.map((b) => b.id), bad.map((b) => b.reason)],
          );
          this.rejected += bad.length;
          for (const b of bad) this.log.error(`outbox row ${b.id} rejected by the event contract: ${b.reason}`);
        }
        if (this.producer && valid.length) {
          const byTopic = new Map<string, typeof valid>();
          for (const v of valid) byTopic.set(v.row.topic, [...(byTopic.get(v.row.topic) ?? []), v]);
          await this.producer.sendBatch({
            acks: -1,
            topicMessages: [...byTopic].map(([topic, list]) => ({
              topic,
              messages: list.map(({ row, event, correlationId }) => ({
                key: row.key,
                value: JSON.stringify(event),
                headers: { 'event-id': row.event_id, 'event-type': row.topic, 'correlation-id': correlationId },
              })),
            })),
          });
        }
        if (valid.length) {
          await updateReturning(q, `UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, [valid.map((v) => v.row.id)]);
        }
        const tap = this.redis.multi();
        for (const { row: r } of valid) {
          tap.lpush(KAFKA_TAP_KEY, JSON.stringify({ eventId: r.event_id, type: r.topic, key: r.key, occurredAt: new Date(r.created_at).toISOString(), mode: this.mode }));
        }
        await tap.ltrim(KAFKA_TAP_KEY, 0, 99).exec();
        this.published += valid.length;
        return valid.length;
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
        service: this.env.SERVICE_NAME,
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
export function envelope(
  r: Pick<OutboxRow, 'event_id' | 'topic' | 'key' | 'payload' | 'created_at'>,
  source = 'ronin-rush',
) {
  const version = Number(/\.v(\d+)$/.exec(r.topic)?.[1] ?? 1);
  return {
    id: r.event_id,
    type: r.topic,
    version,
    occurredAt: new Date(r.created_at).toISOString(),
    source,
    correlationId: r.topic.startsWith('ronin.') ? `round-${r.key}` : r.key,
    data: r.payload,
  };
}

export type OutboxValidation =
  | { ok: true; event: unknown; correlationId: string }
  | { ok: false; reason: string };

/**
 * Wraps an outbox row and validates it against the published contract. Returns the parsed event
 * (exactly what goes on the wire) or the reason it was refused.
 */
export function validateOutboxRow(
  r: Pick<OutboxRow, 'event_id' | 'topic' | 'key' | 'payload' | 'created_at'>,
  source: string,
): OutboxValidation {
  if (!isEventType(r.topic)) return { ok: false, reason: `topic ${r.topic} is not in the event contract` };
  const candidate = envelope(r, source);
  try {
    const event = parseEvent(r.topic, candidate);
    return { ok: true, event, correlationId: candidate.correlationId };
  } catch (e) {
    const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    const reason = issues?.length
      ? issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')
      : (e as Error).message;
    return { ok: false, reason: reason.slice(0, 500) };
  }
}
