import { validateContractEvent } from '@danigil/platform-contracts/testing';
import type { RoundEvent } from '@ronin/shared';
import Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { envelope, OutboxRelay } from '../src/events/outbox-relay.service';
import { ImmediateDrainBarrier } from '../src/round/in-memory';
import { PostgresRoundStore } from '../src/round/postgres-round-store';
import { PostgresSeedSource, ensureActiveChain } from '../src/round/postgres-seed-source';
import { RoundEngine } from '../src/round/round-engine';
import { PostgresLedger } from '../src/wallet/postgres-ledger';
import { CONFIG } from './helpers';
import { TEST_DATABASE_URL, freshSchema } from './db';

/**
 * Contract test (CI): the events Ronin actually persists, produced by the real engine and ledger
 * on PostgreSQL over whole rounds, validated with the kit of @danigil/platform-contracts
 * (validateContractEvent). Not hand-written payloads: whatever the code writes to the outbox.
 *
 * The wallet side is not covered by the kit: Ronin settles through Core's legacy hold routes,
 * which the 0.2.0 OpenAPI deliberately leaves out (docs/wallet.md). Those are exercised against an
 * HTTP stand-in in platform-ledger.test.ts and must be verified against Core itself.
 */
const FAST = { ...CONFIG, bettingMs: 300, resultMs: 100, k: 0.002, publicSalt: 'contract-salt' };
const REDIS_URL = process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeoutMs = 20_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await sleep(10);
  }
};

interface Row {
  id: string;
  event_id: string;
  topic: string;
  key: string;
  payload: unknown;
  created_at: Date;
}

describe.skipIf(!TEST_DATABASE_URL || !REDIS_URL)('event contract: what the real engine and ledger persist', () => {
  let ds: DataSource;
  let rows: Row[] = [];

  beforeAll(async () => {
    ds = await freshSchema('t_contract');
    const ledger = new PostgresLedger(ds);
    await ledger.init();
    const chain = await ensureActiveChain(ds, { length: 200, publicSalt: FAST.publicSalt, terminalSeed: 'e9'.repeat(32) });
    const events: RoundEvent[] = [];
    const engine = new RoundEngine({
      clock: { now: () => Date.now() },
      seeds: new PostgresSeedSource(ds, chain),
      ledger,
      store: new PostgresRoundStore(ds, chain.chainId),
      drain: new ImmediateDrainBarrier(),
      events: { emit: (e) => events.push(e) },
      config: FAST,
      onError: (e) => console.error(e),
    });
    const users = await Promise.all(['aoi', 'ren', 'kai'].map((u) => ledger.createUser({ username: u, grantCents: 50_000 })));
    engine.start(1);
    // Two rounds: a manual cash-out, an automatic one, losses, and a bot.
    for (let r = 0; r < 2; r++) {
      const from = events.length;
      await waitFor(() => events.slice(from).some((e) => e.type === 'round.betting'));
      const roundId = (events.slice(from).find((e) => e.type === 'round.betting') as Extract<RoundEvent, { type: 'round.betting' }>).roundId;
      const [aoi, ren, kai] = users;
      await engine.placeBet({ userId: aoi!.userId, username: 'aoi', amount: 1_000, idempotencyKey: `aoi-${r}-key`, receivedAt: Date.now() });
      await engine.placeBet({ userId: ren!.userId, username: 'ren', amount: 2_500, autoX100: 110, idempotencyKey: `ren-${r}-key`, receivedAt: Date.now() });
      await engine.placeBet({ userId: kai!.userId, username: 'kai', isBot: true, amount: 700, idempotencyKey: `kai-${r}-key`, receivedAt: Date.now() });
      await waitFor(() => events.some((e) => e.type === 'round.started' && e.roundId === roundId));
      await sleep(30);
      await engine.cashOut({ userId: aoi!.userId, roundId, idempotencyKey: `aoi-${r}-out`, receivedAt: Date.now() });
      await waitFor(() => events.some((e) => e.type === 'round.settled' && e.roundId === roundId));
    }
    engine.stop();
    rows = await ds.query(`SELECT id, event_id, topic, key, payload, created_at FROM outbox ORDER BY id`);
  }, 60_000);
  afterAll(async () => ds?.destroy());

  it('covers the five Ronin topics', () => {
    expect(new Set(rows.map((r) => r.topic))).toEqual(
      new Set(['ronin.round.started.v1', 'ronin.bet.placed.v1', 'ronin.bet.cashed_out.v1', 'ronin.round.crashed.v1', 'ronin.round.settled.v1']),
    );
  });

  it('every persisted event validates against the published 0.2.0 schemas', () => {
    const failures: string[] = [];
    for (const r of rows) {
      try {
        validateContractEvent(r.topic as never, envelope(r, 'ronin-rush'));
      } catch (e) {
        failures.push(`${r.topic} #${r.id}: ${(e as Error).message.slice(0, 300)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });

  it('units follow the contract: cents, multipliers x100, epoch milliseconds', () => {
    const cashed = rows.filter((r) => r.topic === 'ronin.bet.cashed_out.v1').map((r) => r.payload as Record<string, unknown>);
    const flat = cashed.filter((p) => 'cashoutX100' in p) as Array<{ cashoutX100: number; payout: number; cashedAt: number }>;
    expect(flat.length).toBeGreaterThan(0);
    for (const p of flat) {
      expect(Number.isInteger(p.cashoutX100) && p.cashoutX100 >= 100).toBe(true);
      expect(Number.isInteger(p.payout)).toBe(true);
      expect(p.cashedAt).toBeGreaterThan(1_700_000_000_000);
    }
  });

  it('an event keeps its id across a failed send and the retry (at-least-once, dedupe by id)', async () => {
    const redis = new Redis(REDIS_URL!, { db: 13 });
    const relay = new OutboxRelay(loadEnv({ KAFKA_BROKERS: 'kafka:9092' }), ds, redis);
    const sent: Array<{ id: string; header: string }> = [];
    let fail = true;
    const internals = relay as unknown as { producer: unknown; connected: boolean };
    internals.connected = true;
    internals.producer = {
      sendBatch: async (b: { topicMessages: Array<{ messages: Array<{ value: string; headers: Record<string, string> }> }> }) => {
        for (const t of b.topicMessages) for (const m of t.messages) sent.push({ id: JSON.parse(m.value).id, header: m.headers['event-id']! });
        if (fail) throw new Error('broker timeout'); // the broker may or may not have stored it
      },
    };
    expect(await relay.tick()).toBe(0); // failed: nothing marked as published
    const firstAttempt = sent.map((s) => s.id);
    fail = false;
    expect(await relay.tick()).toBe(rows.length);
    const retry = sent.slice(firstAttempt.length).map((s) => s.id);
    expect(retry).toEqual(firstAttempt); // same ids, same order: consumers can dedupe
    expect(new Set(retry)).toEqual(new Set(rows.map((r) => r.event_id)));
    expect(sent.every((s) => s.id === s.header)).toBe(true); // event-id header matches the body
    redis.disconnect();
  });
});
