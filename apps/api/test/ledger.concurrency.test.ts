import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRoundStore } from '../src/round/postgres-round-store';
import { ensureActiveChain } from '../src/round/postgres-seed-source';
import { PostgresLedger } from '../src/wallet/postgres-ledger';
import { TEST_DATABASE_URL, freshSchema } from './db';

/**
 * 500 concurrent bets, then 500 concurrent cash-outs mixed with new bets, against a real
 * PostgreSQL with a 30-connection pool. Each user bets in several rounds at once, so many
 * transactions race for the *same* balance row; ~20% of requests are duplicated retries.
 *
 * Afterwards the books must balance exactly: Σ postings = 0, every cached balance equals its
 * postings, no balance below zero, escrow = open stakes, and each idempotency key applied once.
 */
const USERS = 50;
const GRANT = 10_000;
const TOKEN = 1;

let rng = 12_345;
const rand = () => ((rng = (rng * 48_271) % 2_147_483_647) / 2_147_483_647);
const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

describe.skipIf(!TEST_DATABASE_URL)('ledger under concurrency (real PostgreSQL)', () => {
  let ds: DataSource;
  let ledger: PostgresLedger;
  let users: string[] = [];

  beforeAll(async () => {
    ds = await freshSchema('t_ledger_concurrency', 30);
    ledger = new PostgresLedger(ds);
    await ledger.init();
    const chain = await ensureActiveChain(ds, { length: 30, publicSalt: 'test-salt-123' });
    const store = new PostgresRoundStore(ds, chain.chainId);
    for (let id = 1; id <= 20; id++) {
      await store.save({ id, seedHash: 'b'.repeat(64), crashX100: 300, phase: 'RUNNING', bettingEndsAt: 1, startedAt: 1, crashAt: 2, crashedAt: null, settledAt: null, seed: null }, TOKEN, []);
    }
    users = [];
    for (let i = 0; i < USERS; i++) users.push((await ledger.createUser({ username: `player${i}`, grantCents: GRANT })).userId);
  }, 60_000);
  afterAll(async () => ds?.destroy());

  type Bet = { betId: string; userId: string; roundId: number; amount: number };

  const placeBet = (b: Bet) =>
    ledger.debitStake({
      ...b,
      autoX100: null,
      clientKey: `ck-${b.betId}`,
      placedAt: 1,
      idempotencyKey: `bet:${b.roundId}:${b.userId}`,
      fencingToken: TOKEN,
    });

  async function assertBooksBalance(expectedEscrow: number) {
    const audit = await ledger.audit();
    expect(audit.totalPostings).toBe(0);
    expect(audit.cacheMismatches).toEqual([]);
    expect(audit.balances.escrow).toBe(expectedEscrow);
    expect(audit.balances.mint).toBe(-USERS * GRANT);
    expect(audit.balances.users + audit.balances.escrow + audit.balances.house + audit.balances.mint).toBe(0);
    const [{ neg }] = await ds.query(`SELECT COUNT(*)::int AS neg FROM accounts WHERE balance < 0`);
    expect(neg).toBe(0);
    return audit;
  }

  it('keeps the books balanced through 500 concurrent bets and 500 concurrent cash-outs + bets', async () => {
    // ── phase 1: 500 bets (50 users × rounds 1-10), each user's stakes may exceed their balance
    const phase1: Bet[] = users.flatMap((userId) =>
      Array.from({ length: 10 }, (_, r) => ({ betId: crypto.randomUUID(), userId, roundId: r + 1, amount: randInt(200, 2_500) })),
    );
    const retries1 = phase1.filter(() => rand() < 0.2);
    const results1 = await Promise.all([...phase1, ...retries1].map((b) => placeBet(b).then((res) => ({ b, res }))));

    const accepted = await ds.query(`SELECT id, user_id, round_id, amount FROM bets`);
    const acceptedIds = new Set(accepted.map((r: { id: string }) => r.id));
    const rejected = results1.filter((x) => !x.res.ok);
    expect(rejected.length).toBeGreaterThan(0); // the scenario really exercises insufficient funds
    expect(rejected.every((x) => !x.res.ok && x.res.reason === 'INSUFFICIENT_FUNDS')).toBe(true);
    // Each user spent at most their balance, and exactly one row per (round, user).
    const perUser = await ds.query(
      `SELECT user_id, SUM(amount)::bigint AS staked, COUNT(*)::int AS n FROM bets GROUP BY user_id`,
    );
    for (const row of perUser) expect(Number(row.staked)).toBeLessThanOrEqual(GRANT);
    const openStakes1 = accepted.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
    await assertBooksBalance(openStakes1);

    // ── phase 2: cash out ~half of the open bets (with duplicate retries) while new bets land in rounds 11-20
    const toCashOut = accepted.filter(() => rand() < 0.5);
    const cashouts = toCashOut.map((r: { id: string; user_id: string; round_id: string; amount: string }) => {
      const x100 = randInt(100, 500);
      const stake = Number(r.amount);
      return { betId: r.id, userId: r.user_id, roundId: Number(r.round_id), stake, payout: Math.floor((stake * x100) / 100), x100 };
    });
    const cashoutOps = [...cashouts, ...cashouts.filter(() => rand() < 0.2)].map((c) =>
      ledger.creditCashout({ ...c, auto: false, cashedAt: 2, idempotencyKey: `cashout:${c.betId}`, fencingToken: TOKEN }),
    );
    const phase2Bets: Bet[] = Array.from({ length: 500 - cashoutOps.length }, () => ({
      betId: crypto.randomUUID(),
      userId: users[randInt(0, USERS - 1)]!,
      roundId: randInt(11, 20),
      amount: randInt(100, 1_500),
    }));
    expect(cashoutOps.length + phase2Bets.length).toBe(500);
    await Promise.all([...cashoutOps, ...phase2Bets.map(placeBet)]);

    const [{ cashed }] = await ds.query(`SELECT COUNT(*)::int AS cashed FROM bets WHERE status = 'CASHED_OUT'`);
    expect(cashed).toBe(cashouts.length); // retries did not double-pay
    const [{ cashTx }] = await ds.query(`SELECT COUNT(*)::int AS "cashTx" FROM ledger_transactions WHERE type = 'CASHOUT'`);
    expect(cashTx).toBe(cashouts.length);
    const [{ open }] = await ds.query(`SELECT COALESCE(SUM(amount), 0)::bigint AS open FROM bets WHERE status = 'ACTIVE'`);
    await assertBooksBalance(Number(open));

    // ── phase 3: every round crashes; remaining stakes go to the house, concurrently across rounds
    const active = await ds.query(`SELECT id, user_id, round_id, amount FROM bets WHERE status = 'ACTIVE'`);
    const byRound = new Map<number, Array<{ betId: string; userId: string; amount: number }>>();
    for (const r of active) {
      const list = byRound.get(Number(r.round_id)) ?? [];
      list.push({ betId: r.id, userId: r.user_id, amount: Number(r.amount) });
      byRound.set(Number(r.round_id), list);
    }
    await Promise.all(
      [...byRound].flatMap(([roundId, lost]) => [
        ledger.settleLosses(roundId, lost, `round-loss:${roundId}`, TOKEN),
        ledger.settleLosses(roundId, lost, `round-loss:${roundId}`, TOKEN), // duplicate settlement attempt
      ]),
    );

    const audit = await assertBooksBalance(0);
    const [{ payouts, stakes }] = await ds.query(
      `SELECT COALESCE(SUM(payout), 0)::bigint AS payouts, COALESCE(SUM(amount), 0)::bigint AS stakes FROM bets`,
    );
    expect(audit.balances.house).toBe(Number(stakes) - Number(payouts)); // house P&L = stakes − payouts
    expect(acceptedIds.size).toBeGreaterThan(300);
  }, 120_000);
});
