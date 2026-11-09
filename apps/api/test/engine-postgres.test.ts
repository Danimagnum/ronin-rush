import type { RoundEvent } from '@ronin/shared';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImmediateDrainBarrier } from '../src/round/in-memory';
import { PostgresRoundStore } from '../src/round/postgres-round-store';
import { PostgresSeedSource, ensureActiveChain } from '../src/round/postgres-seed-source';
import { RoundEngine } from '../src/round/round-engine';
import { PostgresLedger } from '../src/wallet/postgres-ledger';
import { CONFIG } from './helpers';
import { TEST_DATABASE_URL, freshSchema } from './db';

/**
 * End-to-end on real PostgreSQL with real timers and a fast curve: leader A runs a round,
 * dies mid-flight, leader B resumes it from the database and settles it; A is then fenced out.
 */
const FAST = { ...CONFIG, bettingMs: 400, resultMs: 200, k: 0.002, publicSalt: 'pg-engine-salt' }; // 2x in ~350 ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeoutMs = 15_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await sleep(10);
  }
};

describe.skipIf(!TEST_DATABASE_URL)('RoundEngine on PostgreSQL', () => {
  let ds: DataSource;
  let ledger: PostgresLedger;
  let store: PostgresRoundStore;
  let seeds: PostgresSeedSource;
  let commitment: string;

  beforeAll(async () => {
    ds = await freshSchema('t_engine_pg');
    ledger = new PostgresLedger(ds);
    await ledger.init();
    // Terminal seed chosen so round 1 crashes at 23.52x (~1.6 s with this curve): room to fail over mid-flight.
    const chain = await ensureActiveChain(ds, { length: 200, publicSalt: FAST.publicSalt, terminalSeed: 'e9'.repeat(32) });
    commitment = chain.commitment;
    store = new PostgresRoundStore(ds, chain.chainId);
    seeds = new PostgresSeedSource(ds, chain);
  }, 60_000);
  afterAll(async () => ds?.destroy());

  function engine(name: string, onFenced?: () => void) {
    const events: RoundEvent[] = [];
    const e = new RoundEngine({
      clock: { now: () => Date.now() },
      seeds,
      ledger,
      store,
      drain: new ImmediateDrainBarrier(),
      events: { emit: (ev) => events.push(ev) },
      config: FAST,
      onError: (err) => console.error(name, err),
      onFenced,
    });
    return { e, events, of: <T extends RoundEvent['type']>(t: T) => events.filter((x): x is Extract<RoundEvent, { type: T }> => x.type === t) };
  }

  it('persists rounds, survives a leader crash, settles exactly once and fences the old leader', async () => {
    const players = await Promise.all(['ren', 'yui', 'kai'].map((u) => ledger.createUser({ username: u, grantCents: 10_000 })));
    let fenced = false;
    const a = engine('A', () => (fenced = true));
    a.e.start(1);
    await waitFor(() => a.of('round.betting').length > 0);
    const roundId = a.of('round.betting')[0]!.roundId;

    const [ren, yui, kai] = players;
    expect((await a.e.placeBet({ userId: ren!.userId, username: 'ren', amount: 1_000, autoX100: 150, idempotencyKey: 'ren-key-1', receivedAt: Date.now() })).ok).toBe(true);
    expect((await a.e.placeBet({ userId: yui!.userId, username: 'yui', amount: 2_000, idempotencyKey: 'yui-key-1', receivedAt: Date.now() })).ok).toBe(true);
    expect((await a.e.placeBet({ userId: kai!.userId, username: 'kai', amount: 3_000, idempotencyKey: 'kai-key-1', receivedAt: Date.now() })).ok).toBe(true);

    await waitFor(() => a.of('round.started').length > 0);
    const startedAt = a.of('round.started')[0]!.startedAt;
    a.e.stop(); // leader A "dies" without any cleanup, before ren's 1.50x auto cash-out

    const b = engine('B');
    let resumed: { roundId: number; phase: string } | null = null;
    (b.e as unknown as { deps: { onResume: (i: { roundId: number; phase: string }) => void } }).deps.onResume = (i) => (resumed = i);
    b.e.start(2);
    await waitFor(() => b.of('round.settled').some((s) => s.roundId === roundId));
    const settled = b.of('round.settled').find((s) => s.roundId === roundId)!;
    expect(resumed).toEqual({ roundId, phase: 'RUNNING' });
    expect(b.of('round.started')[0]!.startedAt).toBe(startedAt); // same curve, not a new round
    expect(settled.crashX100).toBe(2352);

    // DB state of the round: settled once, by token 2, seed revealed and consistent with the commitment.
    const [row] = await ds.query(`SELECT phase, seed, fencing_token, crash_x100 FROM rounds WHERE id = $1`, [roundId]);
    expect(row).toMatchObject({ phase: 'SETTLED', seed: settled.seed, fencing_token: '2' });
    expect(Number(row.crash_x100)).toBe(settled.crashX100);
    expect(seeds.commitment).toBe(commitment);

    const bets = await ds.query(`SELECT u.username, b.status, b.cashout_x100 FROM bets b JOIN users u ON u.id = b.user_id WHERE round_id = $1 ORDER BY u.username`, [roundId]);
    expect(bets.every((x: { status: string }) => x.status !== 'ACTIVE')).toBe(true);
    // ren's auto cash-out at 1.50x was executed by B, at exactly 1.50x.
    expect(bets.find((x: { username: string }) => x.username === 'ren')).toMatchObject({ status: 'CASHED_OUT', cashout_x100: 150 });
    expect(bets.filter((x: { status: string }) => x.status === 'LOST')).toHaveLength(2);

    const audit = await ledger.audit();
    expect(audit.totalPostings).toBe(0);
    expect(audit.cacheMismatches).toEqual([]);
    expect(audit.balances.escrow).toBe(0);
    const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type = 'ROUND_LOSS' AND round_id = $1`, [roundId]);
    expect(n).toBeLessThanOrEqual(1);

    // Outbox carries the lifecycle for Kafka.
    const topics = (await ds.query(`SELECT DISTINCT topic FROM outbox ORDER BY topic`)).map((t: { topic: string }) => t.topic);
    expect(topics).toEqual(expect.arrayContaining(['ronin.bet.placed.v1', 'ronin.round.crashed.v1', 'ronin.round.settled.v1', 'ronin.round.started.v1']));

    // A wakes up and tries to keep going: its first write is rejected by the fence.
    a.e.start(1);
    await waitFor(() => fenced);
    expect(a.e.isRunning).toBe(false);
    b.e.stop();
  }, 60_000);
});
