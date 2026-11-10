import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elapsedMsForX100 } from '@ronin/shared';
import { InMemoryLedger, InMemoryRoundStore } from '../src/round/in-memory';
import type { CashoutCredit, DebitResult, StakeDebit } from '../src/round/ports';
import { CONFIG, makeEngine, seedsWhere } from './helpers';

/** A ledger whose every write takes `ms`, like a real database round trip. */
class SlowLedger extends InMemoryLedger {
  writes = 0;
  constructor(private readonly ms: number) {
    super();
  }
  override async debitStake(op: StakeDebit): Promise<DebitResult> {
    this.writes++;
    await new Promise((r) => setTimeout(r, this.ms));
    return super.debitStake(op);
  }
  override async creditCashout(op: CashoutCredit): Promise<number | null> {
    this.writes++;
    await new Promise((r) => setTimeout(r, this.ms));
    return super.creditCashout(op);
  }
}

const T0 = 1_800_000_000_000;
const key = (s: string) => `${s}-idem-key`;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('pipelined ledger writes (decide serially, write concurrently)', () => {
  it('20 simultaneous bets complete in about one write time, not twenty', async () => {
    const ledger = new SlowLedger(50);
    const { engine } = makeEngine({ seeds: seedsWhere(() => true).map((s) => s.seed), ledger, store: new InMemoryRoundStore(ledger) });
    engine.start(1);
    await vi.advanceTimersByTimeAsync(0);
    const all = Promise.all(
      Array.from({ length: 20 }, (_, i) => engine.placeBet({ userId: `u${i}`, username: `u${i}`, amount: 100, idempotencyKey: key(`b${i}`), receivedAt: Date.now() })),
    );
    await vi.advanceTimersByTimeAsync(60); // serial processing would need 20 × 50 ms = 1 s
    const results = await all;
    expect(results.every((r) => r.ok)).toBe(true);
    expect(engine.snapshot()!.bets).toHaveLength(20);
    engine.stop();
  });

  it('a bet accepted just before betting closes is part of the round even if its write lands later', async () => {
    const ledger = new SlowLedger(300);
    const { engine, ofType } = makeEngine({ seeds: seedsWhere((c) => c > 200).map((s) => s.seed), ledger, store: new InMemoryRoundStore(ledger) });
    engine.start(1);
    await vi.advanceTimersByTimeAsync(0);
    const endsAt = engine.snapshot()!.bettingEndsAt;
    await vi.advanceTimersByTimeAsync(endsAt - Date.now() - 10);
    const late = engine.placeBet({ userId: 'last', username: 'last', amount: 100, idempotencyKey: key('last'), receivedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(400); // betting ends while the debit is still in flight
    expect((await late).ok).toBe(true);
    // The round only started once the field was final, with the late bet in it.
    expect(ofType('round.started')).toHaveLength(1);
    expect(engine.snapshot()!.bets.map((b) => b.userId)).toContain('last');
    engine.stop();
  });

  it('a retried cash-out while its write is in flight is paid once', async () => {
    const ledger = new SlowLedger(100);
    const [s] = seedsWhere((c) => c > 300);
    const { engine } = makeEngine({ seeds: [s!.seed], ledger, store: new InMemoryRoundStore(ledger) });
    engine.start(1);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([engine.placeBet({ userId: 'u', username: 'u', amount: 1_000, idempotencyKey: key('u'), receivedAt: Date.now() }), vi.advanceTimersByTimeAsync(150)]);
    await vi.advanceTimersByTimeAsync(CONFIG.bettingMs);
    const startedAt = engine.snapshot()!.startedAt!;
    const at = startedAt + elapsedMsForX100(150, CONFIG.k) + 1;
    await vi.advanceTimersByTimeAsync(Math.ceil(at - Date.now()));
    const a = engine.cashOut({ userId: 'u', roundId: 1, idempotencyKey: key('c1'), receivedAt: at });
    const b = engine.cashOut({ userId: 'u', roundId: 1, idempotencyKey: key('c2'), receivedAt: at + 500 });
    await vi.advanceTimersByTimeAsync(150);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra).toMatchObject({ ok: true, bet: { cashoutX100: 150, payout: 1_500 } });
    expect(ledger.balanceOf('u')).toBe(100_000 - 1_000 + 1_500);
    engine.stop();
  });
});
