import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { appendOutbox } from '../src/db/outbox';
import { withTransaction } from '../src/db/tx';
import { OutboxRelay, validateOutboxRow } from '../src/events/outbox-relay.service';
import { TEST_DATABASE_URL, freshSchema } from './db';

const REDIS_URL = process.env.REDIS_URL;

const row = (topic: string, payload: unknown, key = '7') => ({
  event_id: randomUUID(),
  topic,
  key,
  payload,
  created_at: new Date('2026-11-11T10:00:00Z'),
});

describe('outbox rows against @danigil/platform-contracts 0.3.0', () => {
  it('accepts both published shapes of a bet fact (ledger and engine)', () => {
    const ledger = validateOutboxRow(
      row('ronin.bet.placed.v1', { betId: 'b1', roundId: 7, userId: 'u1', amount: 500, autoX100: null, placedAt: 1_762_855_200_000 }),
      'ronin-rush',
    );
    expect(ledger).toMatchObject({ ok: true, correlationId: 'round-7' });
    const engine = validateOutboxRow(
      row('ronin.bet.cashed_out.v1', {
        type: 'bet.cashed_out',
        auto: true,
        bet: { betId: 'b1', roundId: 7, userId: 'u1', username: 'ana', isBot: false, amount: 500, autoX100: 200, status: 'CASHED_OUT', cashoutX100: 200, payout: 1000 },
      }),
      'ronin-rush',
    );
    expect(engine.ok).toBe(true);
  });

  it('stamps the envelope: stable id, type, version, ISO time, source from SERVICE_NAME', () => {
    const r = row('ronin.round.crashed.v1', { type: 'round.crashed', roundId: 7, crashX100: 341, crashedAt: 1_762_855_200_000 });
    const v = validateOutboxRow(r, 'ronin-rush-staging');
    expect(v.ok && v.event).toMatchObject({
      id: r.event_id,
      type: 'ronin.round.crashed.v1',
      version: 1,
      occurredAt: '2026-11-11T10:00:00.000Z',
      source: 'ronin-rush-staging',
      correlationId: 'round-7',
    });
  });

  it('refuses payloads that break the contract, with a readable reason', () => {
    const wrongUnits = validateOutboxRow(
      row('ronin.round.crashed.v1', { type: 'round.crashed', roundId: 7, crashX100: 3.41, crashedAt: '2026-11-11T10:00:00Z' }),
      'ronin-rush',
    );
    expect(wrongUnits.ok).toBe(false);
    expect(!wrongUnits.ok && wrongUnits.reason).toMatch(/crashedAt/);
    expect(validateOutboxRow(row('ronin.bet.placed.v1', { betId: 'b1' }), 'ronin-rush').ok).toBe(false);
    expect(validateOutboxRow(row('ronin.round.exploded.v1', {}), 'ronin-rush')).toMatchObject({ ok: false, reason: /not in the event contract/ });
  });

  it('health reports follow system.health.reported.v1', () => {
    const ok = validateOutboxRow(row('system.health.reported.v1', { service: 'ronin-rush', status: 'healthy', latencyP95: 12, errorRate: 0 }, 'nas-api-1'), 'ronin-rush');
    expect(ok.ok).toBe(true);
    const bad = validateOutboxRow(row('system.health.reported.v1', { service: 'ronin-rush', status: 'fine', latencyP95: 12, errorRate: 2 }, 'nas-api-1'), 'ronin-rush');
    expect(bad.ok).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('OutboxRelay sets invalid events aside (real PostgreSQL + Redis)', () => {
  let ds: DataSource;
  let redis: Redis;
  let relay: OutboxRelay;

  beforeAll(async () => {
    ds = await freshSchema('t_outbox_contract');
    redis = new Redis(REDIS_URL!, { db: 11 });
    const env = loadEnv({ KAFKA_BROKERS: '', SERVICE_NAME: 'ronin-rush' });
    relay = new OutboxRelay(env, ds, redis);
  });
  afterAll(async () => {
    redis?.disconnect();
    await ds?.destroy();
  });

  it('publishes valid rows, rejects the invalid one with its reason, and never re-reads it', async () => {
    await withTransaction(ds, async (q) => {
      await appendOutbox(q, 'ronin.round.started.v1', 9, { type: 'round.started', roundId: 9, startedAt: 1_762_855_200_000, k: 0.00006 });
      await appendOutbox(q, 'ronin.round.crashed.v1', 9, { type: 'round.crashed', roundId: 9 }); // missing fields
      await appendOutbox(q, 'ronin.round.settled.v1', 9, { type: 'round.settled', roundId: 9, crashX100: 341, seed: 'ab'.repeat(32), settledAt: 1, nextRoundAt: 2 });
    });
    expect(await relay.tick()).toBe(2);
    const rows = await ds.query(`SELECT topic, published_at IS NOT NULL AS published, rejected_at IS NOT NULL AS rejected, reject_reason FROM outbox ORDER BY id`);
    expect(rows.map((r: { published: boolean; rejected: boolean }) => [r.published, r.rejected])).toEqual([
      [true, false],
      [false, true],
      [true, false],
    ]);
    expect(rows[1].reject_reason).toMatch(/crashX100|crashedAt/);
    expect(relay.rejected).toBe(1);
    // The rejected row is not retried and does not hold back later events.
    await withTransaction(ds, (q) => appendOutbox(q, 'ronin.round.started.v1', 10, { type: 'round.started', roundId: 10, startedAt: 1, k: 0.00006 }));
    expect(await relay.tick()).toBe(1);
    expect(await relay.tick()).toBe(0);
    expect(relay.rejected).toBe(1); // still one: the rejected row was never selected again
  });
});
