import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateContractEvent } from '@danigil/platform-contracts/testing';
import Redis from 'ioredis';
import { Kafka, logLevel } from 'kafkajs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real broker: a Ronin API process publishes through its outbox relay to Kafka, and an
 * independent consumer (another service's point of view) reads every topic back.
 * Runs in CI against apache/kafka (KAFKA_E2E_BROKERS); skipped elsewhere.
 */
const DIST = join(__dirname, '..', 'dist', 'main.js');
const BROKERS = process.env.KAFKA_E2E_BROKERS;
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_BASE = process.env.REDIS_URL;
const enabled = Boolean(BROKERS && DB_URL && REDIS_BASE && existsSync(DIST));
const PORT = 3241;
const TOPICS = ['ronin.round.started.v1', 'ronin.bet.placed.v1', 'ronin.bet.cashed_out.v1', 'ronin.round.crashed.v1', 'ronin.round.settled.v1', 'system.health.reported.v1'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Received {
  topic: string;
  key: string;
  headerId: string;
  body: { id: string; type: string; source: string; data: unknown };
}

describe.skipIf(!enabled)('publishing to a real Kafka broker (e2e)', () => {
  let ronin: ChildProcess;
  let log = '';
  const received: Received[] = [];
  const kafka = new Kafka({ clientId: 'kafka-e2e-observer', brokers: (BROKERS ?? '').split(','), logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: `kafka-e2e-observer-${Date.now()}` });

  beforeAll(async () => {
    const admin = new Client({ connectionString: DB_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ronin_e2e_kafka WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ronin_e2e_kafka`);
    await admin.end();
    const redisUrl = REDIS_BASE!.replace(/\/\d*$/, '') + '/7';
    const r = new Redis(redisUrl);
    await r.flushdb();
    r.disconnect();

    ronin = spawn(process.execPath, [DIST], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INSTANCE_ID: 'e2e-kafka',
        PORT: String(PORT),
        DATABASE_URL: DB_URL!.replace(/\/[^/]+$/, '/ronin_e2e_kafka'),
        REDIS_URL: redisUrl,
        REDIS_NAMESPACE: 'ronin-e2e-kafka',
        KAFKA_BROKERS: BROKERS,
        KAFKA_CLIENT_ID: 'ronin-rush-e2e',
        BETTING_MS: '1000',
        RESULT_MS: '400',
        GROWTH_K: '0.001',
        CHAIN_LENGTH: '500',
        BOTS_COUNT: '6',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ronin.stdout!.on('data', (d) => (log += d.toString()));
    ronin.stderr!.on('data', (d) => (log += d.toString()));

    await consumer.connect();
    // Ronin's consumer creates its five topics at start; the shared health topic appears with the
    // first health report (auto-created on publish). Subscribe only once all six exist.
    const kAdmin = kafka.admin();
    await kAdmin.connect();
    const end = Date.now() + 75_000;
    let missing = TOPICS;
    while (Date.now() < end) {
      const topics = new Set(await kAdmin.listTopics());
      missing = TOPICS.filter((t) => !topics.has(t));
      if (!missing.length) break;
      await sleep(500);
    }
    if (missing.length) throw new Error(`topics never appeared: ${missing.join(', ')}\n${log.slice(-2000)}`);
    await kAdmin.disconnect();
    await consumer.subscribe({ topics: TOPICS, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        received.push({
          topic,
          key: message.key?.toString() ?? '',
          headerId: message.headers?.['event-id']?.toString() ?? '',
          body: JSON.parse(message.value!.toString()),
        });
      },
    });
  }, 120_000);

  afterAll(async () => {
    await consumer.disconnect().catch(() => undefined);
    ronin?.kill('SIGTERM');
    await sleep(300);
  });

  it('every Ronin topic reaches the broker, with the platform envelope, and validates against the contract', async () => {
    const end = Date.now() + 60_000;
    while (Date.now() < end && !TOPICS.every((t) => received.some((m) => m.topic === t))) await sleep(250);
    expect(TOPICS.filter((t) => !received.some((m) => m.topic === t)), log.slice(-2000)).toEqual([]);
    const failures: string[] = [];
    for (const m of received) {
      try {
        validateContractEvent(m.topic as never, m.body);
      } catch (e) {
        failures.push(`${m.topic}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 90_000);

  it('keys, headers and ids: round aggregates keyed by round id, event-id header = body id, ids unique', () => {
    for (const m of received) {
      expect(m.headerId).toBe(m.body.id);
      expect(m.body.source).toBe('ronin-rush');
      if (m.topic.startsWith('ronin.')) expect(m.key).toMatch(/^\d+$/);
    }
    const ids = received.map((m) => m.body.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Ronin\'s own consumer group reads them back (System view)', async () => {
    const end = Date.now() + 30_000;
    let consumed = 0;
    while (Date.now() < end) {
      const sys = (await (await fetch(`http://127.0.0.1:${PORT}/api/system`)).json().catch(() => null)) as { kafka?: { mode?: string; consumer?: { consumed?: number } } } | null;
      consumed = sys?.kafka?.consumer?.consumed ?? 0;
      if (sys?.kafka?.mode === 'kafka' && consumed > 0) break;
      await sleep(500);
    }
    expect(consumed).toBeGreaterThan(0);
  }, 40_000);
});
