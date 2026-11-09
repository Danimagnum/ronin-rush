import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elapsedMsForX100, payoutFor, sha256Hex } from '@ronin/shared';
import { CONFIG, ManualDrain, makeEngine, seedsWhere } from './helpers';

const T0 = 1_800_000_000_000;
const K = CONFIG.k;
const key = (s: string) => `${s}-idem-key`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** Lets the serial queue drain at the current fake time. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('state machine', () => {
  it('runs BETTING → RUNNING → CRASHED → SETTLED → BETTING with exact nominal timestamps', async () => {
    const [a, b] = seedsWhere((c) => c > 200 && c < 500, () => true);
    const { engine, events, ofType } = makeEngine({ seeds: [a!.seed, b!.seed] });
    engine.start(1);
    await flush();

    const betting = ofType('round.betting')[0]!;
    expect(betting).toMatchObject({ roundId: 1, bettingEndsAt: T0 + 8_000, seedHash: sha256Hex(a!.seed) });
    expect(engine.snapshot()).toMatchObject({ phase: 'BETTING', crashX100: null });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(ofType('round.started')[0]).toEqual({ type: 'round.started', roundId: 1, startedAt: T0 + 8_000, k: K });
    // The crash point is not exposed while running.
    expect(engine.snapshot()).toMatchObject({ phase: 'RUNNING', crashX100: null });

    const crashAt = T0 + 8_000 + elapsedMsForX100(a!.crashX100, K);
    await vi.advanceTimersByTimeAsync(Math.ceil(crashAt - Date.now()));
    expect(ofType('round.crashed')[0]).toMatchObject({ crashX100: a!.crashX100, crashedAt: crashAt });

    const settled = ofType('round.settled')[0]!;
    expect(settled).toMatchObject({ roundId: 1, seed: a!.seed, nextRoundAt: crashAt + 3_000 });
    expect(sha256Hex(settled.seed)).toBe(betting.seedHash); // commitment honoured

    await vi.advanceTimersByTimeAsync(3_000);
    expect(ofType('round.betting')[1]).toMatchObject({ roundId: 2, seedHash: sha256Hex(b!.seed) });
    expect(events.map((e) => e.type).slice(0, 5)).toEqual([
      'round.betting',
      'round.started',
      'round.crashed',
      'round.settled',
      'round.betting',
    ]);
    expect(engine.recentRounds()[0]).toMatchObject({ roundId: 1, crashX100: a!.crashX100 });
    engine.stop();
  });

  it('a 1.00x round crashes the instant it starts and loses every bet', async () => {
    const [s] = seedsWhere((c) => c === 100);
    const { engine, ofType, ledger } = makeEngine({ seeds: [s!.seed] });
    engine.start(1);
    await flush();
    expect((await engine.placeBet({ userId: 'u1', username: 'u1', amount: 500, idempotencyKey: key('a'), receivedAt: Date.now() })).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    const started = ofType('round.started')[0]!;
    expect(ofType('round.crashed')[0]).toMatchObject({ crashX100: 100, crashedAt: started.startedAt });
    expect(ofType('bets.lost')[0]!.betIds).toHaveLength(1);
    expect(ledger.house).toBe(500);
    engine.stop();
  });

  it('stop() halts the loop', async () => {
    const { engine, events } = makeEngine({ seeds: seedsWhere(() => true).map((s) => s.seed) });
    engine.start(1);
    await flush();
    engine.stop();
    const n = events.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(n);
  });
});

describe('betting window', () => {
  it('validates timing, duplicates, idempotency and funds', async () => {
    const { engine } = makeEngine({ seeds: seedsWhere(() => true).map((s) => s.seed), balance: 1_000 });
    engine.start(1);
    await flush();
    const endsAt = engine.snapshot()!.bettingEndsAt;

    const first = await engine.placeBet({ userId: 'u1', username: 'u1', amount: 100, autoX100: 200, idempotencyKey: key('1'), receivedAt: Date.now() });
    expect(first.ok).toBe(true);
    // Retry with the same key returns the same bet, no double debit.
    const retry = await engine.placeBet({ userId: 'u1', username: 'u1', amount: 100, autoX100: 200, idempotencyKey: key('1'), receivedAt: Date.now() });
    expect(retry.ok && first.ok && retry.bet).toEqual(first.ok && first.bet);
    expect(await engine.placeBet({ userId: 'u1', username: 'u1', amount: 100, idempotencyKey: key('2'), receivedAt: Date.now() })).toEqual({ ok: false, error: 'ALREADY_BET' });
    expect(await engine.placeBet({ userId: 'u2', username: 'u2', amount: 5_000, idempotencyKey: key('3'), receivedAt: Date.now() })).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    expect(await engine.placeBet({ userId: 'u3', username: 'u3', amount: 5, idempotencyKey: key('4'), receivedAt: Date.now() })).toEqual({ ok: false, error: 'VALIDATION_ERROR' });

    // Arrives exactly at bettingEndsAt (still processed while phase is BETTING) -> rejected by timestamp.
    expect(await engine.placeBet({ userId: 'u4', username: 'u4', amount: 100, idempotencyKey: key('5'), receivedAt: endsAt })).toEqual({ ok: false, error: 'BETTING_CLOSED' });
    expect(await engine.cashOut({ userId: 'u1', roundId: 1, idempotencyKey: key('6'), receivedAt: Date.now() })).toEqual({ ok: false, error: 'NOT_RUNNING' });
    engine.stop();
  });
});

describe('server-authoritative cash-out', () => {
  it('pays m(receivedAt), not the multiplier at processing time', async () => {
    const [s] = seedsWhere((c) => c > 300);
    const { engine, ledger } = makeEngine({ seeds: [s!.seed] });
    engine.start(1);
    await flush();
    await engine.placeBet({ userId: 'u1', username: 'u1', amount: 1_000, idempotencyKey: key('b'), receivedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(8_000);
    const startedAt = engine.snapshot()!.startedAt!;

    // The request hit the socket 1 ms after 1.50x but is only processed 2 s later.
    const receivedAt = startedAt + elapsedMsForX100(150, K) + 1;
    await vi.advanceTimersByTimeAsync(Math.ceil(receivedAt - Date.now()) + 2_000);
    const res = await engine.cashOut({ userId: 'u1', roundId: 1, idempotencyKey: key('c'), receivedAt });
    expect(res).toMatchObject({ ok: true, bet: { status: 'CASHED_OUT', cashoutX100: 150, payout: 1_500 } });
    // Idempotent: a second click changes nothing.
    expect(await engine.cashOut({ userId: 'u1', roundId: 1, idempotencyKey: key('d'), receivedAt: Date.now() })).toEqual(res);
    expect(ledger.balanceOf('u1')).toBe(100_000 - 1_000 + 1_500);
    engine.stop();
  });

  it('honours a cash-out received before the crash but processed during the drain window; rejects one received at the crash', async () => {
    const [s] = seedsWhere((c) => c > 200 && c < 400);
    const drain = new ManualDrain();
    const { engine, ofType, ledger } = makeEngine({ seeds: [s!.seed], drain });
    engine.start(1);
    await flush();
    for (const u of ['early', 'late', 'idle']) {
      await engine.placeBet({ userId: u, username: u, amount: 1_000, idempotencyKey: key(u), receivedAt: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(8_000);
    const crashAt = engine.snapshot()!.startedAt! + elapsedMsForX100(s!.crashX100, K);
    await vi.advanceTimersByTimeAsync(Math.ceil(crashAt - Date.now()) + 50);
    expect(engine.snapshot()!.phase).toBe('CRASHED');

    // Relayed from another instance: stamped 5 ms before the crash, arrives now.
    const early = await engine.cashOut({ userId: 'early', roundId: 1, idempotencyKey: key('e2'), receivedAt: crashAt - 5 });
    expect(early).toMatchObject({ ok: true, bet: { status: 'CASHED_OUT' } });
    if (early.ok) expect(early.bet.cashoutX100!).toBeLessThan(s!.crashX100);

    const late = await engine.cashOut({ userId: 'late', roundId: 1, idempotencyKey: key('l2'), receivedAt: crashAt });
    expect(late).toEqual({ ok: false, error: 'CASHOUT_AFTER_CRASH' });

    drain.open();
    await flush();
    expect(engine.snapshot()!.phase).toBe('SETTLED');
    expect(ofType('bets.lost')[0]!.betIds).toHaveLength(2);
    // After settlement even an in-window timestamp is too late: the bet is already lost.
    expect(await engine.cashOut({ userId: 'idle', roundId: 1, idempotencyKey: key('i2'), receivedAt: crashAt - 1 })).toEqual({
      ok: false,
      error: 'CASHOUT_AFTER_CRASH',
    });
    expect(ledger.escrow).toBe(0);
    engine.stop();
  });
});

describe('auto cash-out', () => {
  it('is executed by the server at exactly the target; a target >= crash loses', async () => {
    const [s] = seedsWhere((c) => c > 250 && c < 800);
    const { engine, ofType } = makeEngine({ seeds: [s!.seed] });
    engine.start(1);
    await flush();
    await engine.placeBet({ userId: 'a', username: 'a', amount: 1_000, autoX100: 150, idempotencyKey: key('a'), receivedAt: Date.now() });
    await engine.placeBet({ userId: 'b', username: 'b', amount: 1_000, autoX100: 237, idempotencyKey: key('b'), receivedAt: Date.now() });
    await engine.placeBet({ userId: 'c', username: 'c', amount: 1_000, autoX100: s!.crashX100, idempotencyKey: key('c'), receivedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(8_000);
    const startedAt = engine.snapshot()!.startedAt!;

    // Just before 1.50x nothing has happened yet: the server never cashes out early.
    await vi.advanceTimersByTimeAsync(Math.floor(startedAt + elapsedMsForX100(150, K) - Date.now()) - 5);
    expect(ofType('bet.cashed_out')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(ofType('bet.cashed_out')[0]).toMatchObject({ auto: true, bet: { userId: 'a', cashoutX100: 150, payout: 1_500 } });

    await vi.advanceTimersByTimeAsync(120_000);
    const cashed = ofType('bet.cashed_out').map((e) => [e.bet.userId, e.bet.cashoutX100]);
    expect(cashed).toEqual([
      ['a', 150],
      ['b', 237],
    ]);
    expect(ofType('bets.lost')[0]!.betIds).toHaveLength(1); // c: target == crash point loses
    engine.stop();
  });

  it('a manual click after the auto target was passed pays the auto target', async () => {
    const [s] = seedsWhere((c) => c > 300);
    const { engine } = makeEngine({ seeds: [s!.seed] });
    engine.start(1);
    await flush();
    await engine.placeBet({ userId: 'u', username: 'u', amount: 1_000, autoX100: 200, idempotencyKey: key('u'), receivedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(8_000);
    const startedAt = engine.snapshot()!.startedAt!;
    // Simulate the click being processed before the auto timer had a chance to run.
    const res = await engine.cashOut({ userId: 'u', roundId: 1, idempotencyKey: key('m'), receivedAt: startedAt + elapsedMsForX100(250, K) });
    expect(res).toMatchObject({ ok: true, bet: { cashoutX100: 200, payout: payoutFor(1_000, 200) } });
    engine.stop();
  });
});

describe('ledger consistency across many rounds', () => {
  it('money is conserved and escrow returns to zero after every settled round', async () => {
    const seeds = seedsWhere(...Array.from({ length: 25 }, () => () => true)).map((s) => s.seed);
    const { engine, ledger } = makeEngine({ seeds });
    const users = Array.from({ length: 30 }, (_, i) => `p${i}`);
    users.forEach((u) => ledger.balanceOf(u));
    const initial = ledger.total();
    let rng = 7;
    const rand = () => ((rng = (rng * 48_271) % 2_147_483_647) / 2_147_483_647);
    const phase = () => engine.snapshot()?.phase;
    const until = async (p: string) => {
      while (phase() !== p) await vi.advanceTimersByTimeAsync(50);
    };

    engine.start(1);
    for (let i = 0; i < 20; i++) {
      await until('BETTING');
      const roundId = engine.snapshot()!.roundId;
      for (const u of users) {
        const autoX100 = rand() < 0.5 ? 101 + Math.floor(rand() * 400) : null;
        const res = await engine.placeBet({ userId: u, username: u, amount: 10 + Math.floor(rand() * 2_000), autoX100, idempotencyKey: key(`${u}-${roundId}`), receivedAt: Date.now() });
        expect(res.ok).toBe(true);
      }
      await until('RUNNING');
      while (phase() === 'RUNNING') {
        await vi.advanceTimersByTimeAsync(100 + Math.floor(rand() * 900));
        const u = users[Math.floor(rand() * users.length)]!;
        await engine.cashOut({ userId: u, roundId, idempotencyKey: key(`${u}-${roundId}-c`), receivedAt: Date.now() });
      }
      await until('SETTLED');
      const bets = engine.snapshot()!.bets;
      expect(bets.every((b) => b.status !== 'ACTIVE')).toBe(true);
      expect(ledger.escrow).toBe(0);
      expect(ledger.total()).toBe(initial);
    }
    engine.stop();
  });
});

describe('metrics', () => {
  it('records how late timers fire as round-loop latency', async () => {
    const { engine } = makeEngine({ seeds: seedsWhere(() => true).map((s) => s.seed) });
    engine.start(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(engine.metrics().loopLatencyMs.max).toBeGreaterThanOrEqual(0);
    engine.stop();
  });
});
