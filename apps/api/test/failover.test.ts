import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elapsedMsForX100 } from '@ronin/shared';
import { InMemoryLedger, InMemoryRoundStore } from '../src/round/in-memory';
import { CONFIG, makeEngine, seedsWhere } from './helpers';

const T0 = 1_800_000_000_000;
const K = CONFIG.k;
const key = (s: string) => `${s}-idem-key`;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function sharedStorage() {
  const ledger = new InMemoryLedger();
  const store = new InMemoryRoundStore(ledger);
  return { ledger, store };
}

describe('leader failover', () => {
  it('a new leader resumes the same RUNNING round: same id, crash instant, bets and autos', async () => {
    const [s] = seedsWhere((c) => c > 300 && c < 900);
    const shared = sharedStorage();
    const a = makeEngine({ seeds: [s!.seed], ...shared });
    a.engine.start(1);
    await flush();
    await a.engine.placeBet({ userId: 'auto', username: 'auto', amount: 1_000, autoX100: 250, idempotencyKey: key('a'), receivedAt: Date.now() });
    await a.engine.placeBet({ userId: 'manual', username: 'manual', amount: 1_000, idempotencyKey: key('m'), receivedAt: Date.now() });
    await a.engine.placeBet({ userId: 'idle', username: 'idle', amount: 1_000, idempotencyKey: key('i'), receivedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(9_000); // running, ~1.06x
    const before = a.engine.snapshot()!;
    expect(before.phase).toBe('RUNNING');

    a.engine.stop(); // leader dies
    await vi.advanceTimersByTimeAsync(2_000); // lease expiry gap

    const b = makeEngine({ seeds: [s!.seed], ...shared });
    b.engine.start(2);
    await flush();
    const after = b.engine.snapshot()!;
    expect(after).toMatchObject({ roundId: 1, phase: 'RUNNING', startedAt: before.startedAt });
    expect(after.bets.map((x) => x.userId).sort()).toEqual(['auto', 'idle', 'manual']);
    expect(b.ofType('round.started')[0]!.startedAt).toBe(before.startedAt); // clients resync to the same curve

    const t200 = before.startedAt! + elapsedMsForX100(200, K) + 1;
    await vi.advanceTimersByTimeAsync(Math.ceil(t200 - Date.now()));
    expect(await b.engine.cashOut({ userId: 'manual', roundId: 1, idempotencyKey: key('m2'), receivedAt: t200 })).toMatchObject({
      ok: true,
      bet: { cashoutX100: 200 },
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(b.ofType('round.crashed')[0]).toMatchObject({
      crashX100: s!.crashX100,
      crashedAt: before.startedAt! + elapsedMsForX100(s!.crashX100, K),
    });
    expect(b.ofType('bet.cashed_out').find((e) => e.bet.userId === 'auto')).toMatchObject({ auto: true, bet: { cashoutX100: 250 } });
    expect(shared.ledger.escrow).toBe(0);
    b.engine.stop();
  });

  it('if the crash instant passed while nobody was leader, the new leader crashes at once and still pays winning autos', async () => {
    const [s] = seedsWhere((c) => c > 200 && c < 400);
    const shared = sharedStorage();
    const a = makeEngine({ seeds: [s!.seed], ...shared });
    a.engine.start(1);
    await flush();
    await a.engine.placeBet({ userId: 'auto', username: 'auto', amount: 1_000, autoX100: 150, idempotencyKey: key('a'), receivedAt: Date.now() });
    await a.engine.placeBet({ userId: 'idle', username: 'idle', amount: 1_000, idempotencyKey: key('i'), receivedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(8_500);
    a.engine.stop();
    await vi.advanceTimersByTimeAsync(60_000); // long outage, way past the crash

    const b = makeEngine({ seeds: [s!.seed], ...shared });
    b.engine.start(2);
    await flush();
    expect(b.ofType('round.crashed')).toHaveLength(1);
    expect(b.ofType('bet.cashed_out')[0]).toMatchObject({ auto: true, bet: { userId: 'auto', cashoutX100: 150 } });
    expect(b.ofType('round.settled')[0]).toMatchObject({ roundId: 1, seed: s!.seed });
    expect(shared.ledger.escrow).toBe(0);
    b.engine.stop();
  });

  it('overdue transitions after an outage are not reported as timer latency', async () => {
    const [s] = seedsWhere((c) => c > 200);
    const shared = sharedStorage();
    const a = makeEngine({ seeds: [s!.seed], ...shared });
    a.engine.start(1);
    await flush();
    a.engine.stop(); // dies during BETTING
    await vi.advanceTimersByTimeAsync(60_000); // the betting window closed a minute ago

    const b = makeEngine({ seeds: [s!.seed], ...shared });
    b.engine.start(2);
    await vi.advanceTimersByTimeAsync(100);
    // Round 1 was started, crashed and settled at once (all overdue); round 2 is now open.
    expect(b.ofType('round.settled')[0]).toMatchObject({ roundId: 1 });
    expect(b.engine.snapshot()).toMatchObject({ roundId: 2, phase: 'BETTING' });
    expect(b.engine.metrics().loopLatencyMs.max).toBeLessThan(50);
    b.engine.stop();
  });

  it('resumes a BETTING round with its bets and keeps client idempotency', async () => {
    const [s] = seedsWhere(() => true);
    const shared = sharedStorage();
    const a = makeEngine({ seeds: [s!.seed], ...shared });
    a.engine.start(1);
    await flush();
    const first = await a.engine.placeBet({ userId: 'u', username: 'u', amount: 500, idempotencyKey: key('u'), receivedAt: Date.now() });
    a.engine.stop();

    const b = makeEngine({ seeds: [s!.seed], ...shared });
    b.engine.start(2);
    await flush();
    expect(b.engine.snapshot()).toMatchObject({ roundId: 1, phase: 'BETTING' });
    // The client retries its request against the new leader: same bet, no second debit.
    const retry = await b.engine.placeBet({ userId: 'u', username: 'u', amount: 500, idempotencyKey: key('u'), receivedAt: Date.now() });
    expect(retry.ok && first.ok && retry.bet.betId === first.bet.betId).toBe(true);
    expect(shared.ledger.balanceOf('u')).toBe(100_000 - 500);
    b.engine.stop();
  });

  it('continues numbering after a SETTLED round', async () => {
    const seeds = seedsWhere((c) => c < 150, () => true).map((x) => x.seed);
    const shared = sharedStorage();
    const a = makeEngine({ seeds, ...shared });
    a.engine.start(1);
    while (a.ofType('round.settled').length === 0) await vi.advanceTimersByTimeAsync(500);
    a.engine.stop();

    const b = makeEngine({ seeds, ...shared });
    b.engine.start(2);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(b.ofType('round.betting')[0]).toMatchObject({ roundId: 2 });
    expect(b.engine.recentRounds()[0]).toMatchObject({ roundId: 1 });
    b.engine.stop();
  });
});

describe('fencing', () => {
  it('a stale leader that keeps running is fenced out on its next write and stops', async () => {
    const [s] = seedsWhere((c) => c > 300);
    const shared = sharedStorage();
    let fenced = false;
    const a = makeEngine({ seeds: [s!.seed], ...shared, onFenced: () => (fenced = true) });
    a.engine.start(1);
    await flush();
    await a.engine.placeBet({ userId: 'u', username: 'u', amount: 1_000, idempotencyKey: key('u'), receivedAt: Date.now() });

    // A pauses (GC, network partition). Its lease expires and B takes over with token 2.
    const b = makeEngine({ seeds: [s!.seed], ...shared });
    b.engine.start(2);
    await flush();

    // B claimed the fence on takeover. A wakes up still believing it is leader: its next
    // write (starting the round) is rejected by the fence.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fenced).toBe(true);
    expect(a.engine.isRunning).toBe(false);
    expect(await a.engine.cashOut({ userId: 'u', roundId: 1, idempotencyKey: key('c'), receivedAt: Date.now() })).toEqual({
      ok: false,
      error: 'NOT_LEADER',
    });
    expect(b.engine.snapshot()!.phase).toBe('RUNNING');
    b.engine.stop();
  });
});
