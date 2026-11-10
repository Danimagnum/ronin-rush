import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { KafkaConsumedEntry } from '@ronin/shared';
import type Redis from 'ioredis';
import { Kafka, logLevel, type Admin, type Consumer } from 'kafkajs';
import type { Env } from '../config/env';
import { ENV, REDIS } from '../config/tokens';
import { TOPICS } from '../db/outbox';

export const KAFKA_CONSUMED_KEY = 'ronin:kafka:consumed';
export const KAFKA_CONSUMED_COUNT_KEY = 'ronin:kafka:consumed:count';
export const KAFKA_LAG_KEY = 'ronin:kafka:lag';

/**
 * Reads the game's own events back from Kafka, as an independent downstream service would.
 * One consumer group shared by every API instance, so Kafka splits the partitions among them;
 * each consumed record (topic, partition, offset, end-to-end delay) is mirrored to Redis
 * for the System view. Proves the whole path: ledger transaction → outbox → relay → broker → consumer.
 */
@Injectable()
export class KafkaTapConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('KafkaTapConsumer');
  private consumer: Consumer | null = null;
  private admin: Admin | null = null;
  private lagTimer: NodeJS.Timeout | null = null;
  readonly topics = Object.values(TOPICS);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  get groupId(): string {
    return `${this.env.KAFKA_CLIENT_ID}-system-view`;
  }

  get enabled(): boolean {
    return Boolean(this.env.KAFKA_BROKERS) && this.env.KAFKA_CONSUMER_ENABLED;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const kafka = new Kafka({
      clientId: `${this.env.KAFKA_CLIENT_ID}-tap`,
      brokers: this.env.KAFKA_BROKERS.split(','),
      logLevel: logLevel.WARN,
      retry: { retries: 10 },
    });
    this.admin = kafka.admin();
    this.consumer = kafka.consumer({ groupId: this.groupId, sessionTimeout: 15_000, heartbeatInterval: 3_000 });
    // Connect in the background: a missing broker must never block the game from starting.
    void this.start().catch((e: Error) => this.log.error(`Kafka consumer not started: ${e.message}`));
  }

  private async start(): Promise<void> {
    await this.admin!.connect();
    // Explicit topics (3 partitions each) instead of relying on broker auto-creation.
    const existing = new Set(await this.admin!.listTopics());
    const missing = this.topics.filter((t) => !existing.has(t));
    if (missing.length) {
      await this.admin!.createTopics({
        waitForLeaders: true,
        topics: missing.map((topic) => ({ topic, numPartitions: this.env.KAFKA_PARTITIONS, replicationFactor: 1 })),
      });
      this.log.log(`created topics: ${missing.join(', ')}`);
    }
    await this.consumer!.connect();
    await this.consumer!.subscribe({ topics: this.topics, fromBeginning: false });
    await this.consumer!.run({
      eachMessage: async ({ topic, partition, message }) => {
        const entry = toConsumedEntry(topic, partition, message, Date.now());
        await this.redis
          .multi()
          .lpush(KAFKA_CONSUMED_KEY, JSON.stringify(entry))
          .ltrim(KAFKA_CONSUMED_KEY, 0, 49)
          .incr(KAFKA_CONSUMED_COUNT_KEY)
          .exec();
      },
    });
    this.log.log(`consuming ${this.topics.length} topics as group ${this.groupId}`);
    this.lagTimer = setInterval(() => void this.measureLag(), 5_000);
  }

  /** Consumer lag = sum over partitions of (latest offset − committed offset). */
  private async measureLag(): Promise<void> {
    try {
      let lag = 0;
      const committed = await this.admin!.fetchOffsets({ groupId: this.groupId, topics: this.topics });
      for (const { topic, partitions } of committed) {
        const latest = await this.admin!.fetchTopicOffsets(topic);
        const high = new Map(latest.map((p) => [p.partition, Number(p.high)]));
        for (const p of partitions) {
          const c = Number(p.offset);
          lag += Math.max(0, (high.get(p.partition) ?? 0) - (c < 0 ? 0 : c));
        }
      }
      await this.redis.set(KAFKA_LAG_KEY, String(lag), 'PX', 15_000);
    } catch (e) {
      this.log.warn(`lag check failed: ${(e as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.lagTimer) clearInterval(this.lagTimer);
    await this.consumer?.disconnect().catch(() => undefined);
    await this.admin?.disconnect().catch(() => undefined);
  }
}

interface RawMessage {
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
  timestamp: string;
  headers?: Record<string, unknown>;
}

/** Pure mapping, unit-tested: a Kafka record → what the System view shows. */
export function toConsumedEntry(topic: string, partition: number, message: RawMessage, now: number): KafkaConsumedEntry {
  let eventId = '';
  let occurredAt = Number(message.timestamp);
  try {
    const body = JSON.parse(message.value?.toString('utf8') ?? '{}') as { id?: string; occurredAt?: string };
    eventId = body.id ?? '';
    if (body.occurredAt) occurredAt = Date.parse(body.occurredAt);
  } catch {
    // not one of ours: still shown, without an event id
  }
  return {
    topic,
    partition,
    offset: message.offset,
    key: message.key?.toString('utf8') ?? '',
    eventId,
    endToEndMs: Math.max(0, now - occurredAt),
    consumedAt: new Date(now).toISOString(),
  };
}
