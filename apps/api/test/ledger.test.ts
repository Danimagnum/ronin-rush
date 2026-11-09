import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimFence } from '../src/db/fence';
import { withTransaction } from '../src/db/tx';
import { FencedOutError } from '../src/round/ports';
import { PostgresRoundStore } from '../src/round/postgres-round-store';
import { ensureActiveChain } from '../src/round/postgres-seed-source';
import { PostgresLedger } from '../src/wallet/postgres-ledger';
import { TEST_DATABASE_URL, freshSchema } from './db';

describe.skipIf(!TEST_DATABASE_URL)('PostgresLedger (real PostgreSQL)', () => {
  let ds: DataSource;
  let ledger: PostgresLedger;
  const TOKEN = 1;

  beforeAll(async () => {
    ds = await freshSchema('t_ledger');
    ledger = new PostgresLedger(ds);
    await ledger.init();
    const chain = await ensureActiveChain(ds, { length: 10, publicSalt: 'test-salt-123' });
    const store = new PostgresRoundStore(ds, chain.chainId);
    for (const id of [1, 2, 3]) {
      await store.save({ id, seedHash: 'a'.repeat(64), crashX100: 200, phase: 'BETTING', bettingEndsAt: 1, startedAt: null, crashAt: null, crashedAt: null, settledAt: null, seed: null }, TOKEN, []);
    }
  });
  afterAll(async () => ds?.destroy());

  const debit = (userId: string, roundId: number, amount: number, extra: Partial<{ key: string; token: number }> = {}) =>
    ledger.debitStake({
      betId: crypto.randomUUID(),
      userId,
      roundId,
      amount,
      autoX100: null,
      clientKey: crypto.randomUUID(),
      placedAt: 1,
      idempotencyKey: extra.key ?? `bet:${roundId}:${userId}`,
      fencingToken: extra.token ?? TOKEN,
    });

  it('runs the full bet -> cash-out / loss flow with balanced postings', async () => {
    const alice = await ledger.createUser({ username: 'alice', grantCents: 10_000 });
    const bob = await ledger.createUser({ username: 'bob', grantCents: 10_000 });

    expect(await debit(alice.userId, 1, 1_000)).toEqual({ ok: true, balance: 9_000 });
    expect(await debit(bob.userId, 1, 2_000)).toEqual({ ok: true, balance: 8_000 });
    const [aliceBet] = await ds.query(`SELECT id FROM bets WHERE user_id = $1`, [alice.userId]);
    const [bobBet] = await ds.query(`SELECT id FROM bets WHERE user_id = $1`, [bob.userId]);

    await ledger.creditCashout({ betId: aliceBet.id, userId: alice.userId, roundId: 1, stake: 1_000, payout: 2_500, x100: 250, auto: false, cashedAt: 2, idempotencyKey: `cashout:${aliceBet.id}`, fencingToken: TOKEN });
    await ledger.settleLosses(1, [{ betId: bobBet.id, userId: bob.userId, amount: 2_000 }], 'round-loss:1', TOKEN);

    expect(await ledger.balanceOf(alice.userId)).toBe(11_500);
    expect(await ledger.balanceOf(bob.userId)).toBe(8_000);
    const audit = await ledger.audit();
    expect(audit.totalPostings).toBe(0);
    expect(audit.cacheMismatches).toEqual([]);
    expect(audit.balances).toEqual({ escrow: 0, house: 2_000 - 1_500, mint: -20_000, users: 19_500 });

    const statuses = await ds.query(`SELECT status, cashout_x100, payout FROM bets WHERE round_id = 1 ORDER BY amount`);
    expect(statuses).toEqual([
      { status: 'CASHED_OUT', cashout_x100: 250, payout: '2500' },
      { status: 'LOST', cashout_x100: null, payout: '0' },
    ]);
    const topics = await ds.query(`SELECT topic, COUNT(*)::int AS n FROM outbox GROUP BY topic ORDER BY topic`);
    expect(topics).toEqual([
      { topic: 'ronin.bet.cashed_out.v1', n: 1 },
      { topic: 'ronin.bet.placed.v1', n: 2 },
    ]);
  });

  it('applies each idempotency key once, even when retried', async () => {
    const u = await ledger.createUser({ username: 'carol', grantCents: 5_000 });
    expect((await debit(u.userId, 2, 1_000)).ok).toBe(true);
    expect(await debit(u.userId, 2, 1_000)).toEqual({ ok: true, balance: null }); // replay
    expect(await ledger.balanceOf(u.userId)).toBe(4_000);
    expect(await ledger.grant(u.userId, 500, 'refill-1')).toBe(4_500);
    expect(await ledger.grant(u.userId, 500, 'refill-1')).toBe(4_500);
  });

  it('refuses to overdraw and leaves no trace of the failed attempt', async () => {
    const u = await ledger.createUser({ username: 'dave', grantCents: 100 });
    expect(await debit(u.userId, 3, 101)).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE idempotency_key = $1`, [`bet:3:${u.userId}`]);
    expect(n).toBe(0); // rolled back, so the client may retry with more funds
    expect(await debit(u.userId, 3, 100)).toEqual({ ok: true, balance: 0 });
  });

  it('rejects writes from a fenced-out leader', async () => {
    const u = await ledger.createUser({ username: 'erin', grantCents: 1_000 });
    await withTransaction(ds, (q) => claimFence(q, 7));
    await expect(debit(u.userId, 1, 10, { token: 6 })).rejects.toBeInstanceOf(FencedOutError);
    expect(await ledger.balanceOf(u.userId)).toBe(1_000);
    await expect(withTransaction(ds, (q) => claimFence(q, 6))).rejects.toBeInstanceOf(FencedOutError);
  });

  describe('database-enforced invariants', () => {
    it('an unbalanced transaction cannot commit', async () => {
      const [acc] = await ds.query(`SELECT id FROM accounts WHERE kind = 'house'`);
      await expect(
        withTransaction(ds, async (q) => {
          const [tx] = await q.query(`INSERT INTO ledger_transactions (type, idempotency_key) VALUES ('GRANT', 'evil') RETURNING id`);
          await q.query(`INSERT INTO postings (transaction_id, account_id, amount) VALUES ($1, $2, 1000)`, [tx.id, acc.id]);
        }),
      ).rejects.toThrow(/unbalanced ledger transaction/);
    });

    it('postings are append-only', async () => {
      await expect(ds.query(`UPDATE postings SET amount = amount * 2`)).rejects.toThrow(/append-only/);
      await expect(ds.query(`DELETE FROM ledger_transactions`)).rejects.toThrow(/append-only/);
    });

    it('a user balance can never go negative, even bypassing the application', async () => {
      await expect(ds.query(`UPDATE accounts SET balance = -1 WHERE kind = 'user'`)).rejects.toThrow(/no_overdraft/);
    });
  });
});
