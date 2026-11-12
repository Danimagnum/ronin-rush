import type { DataSource, QueryRunner } from 'typeorm';
import { assertFence } from '../db/fence';
import { appendOutbox, TOPICS } from '../db/outbox';
import { Rollback, num, updateReturning, withTransaction, withTransactionOr } from '../db/tx';
import type { BetLedger, CashoutCredit, DebitResult, LostStake, StakeDebit } from '../round/ports';

type SystemKind = 'escrow' | 'house' | 'mint';

export interface LedgerAudit {
  /** Σ of every posting ever written: must be 0. */
  totalPostings: number;
  /** User accounts whose cached balance differs from Σ(postings). Must be empty. */
  cacheMismatches: Array<{ accountId: string; cached: number; computed: number }>;
  balances: Record<SystemKind, number> & { users: number };
  transactions: number;
  postings: number;
}

/**
 * Double-entry wallet on PostgreSQL.
 *
 *  bet       user  -stake           escrow +stake
 *  cash-out  escrow -stake  house -(payout-stake)   user +payout
 *  loss      escrow -Σstakes        house +Σstakes            (one tx per round)
 *  grant     mint  -amount          user  +amount             (play money only)
 *
 * Each operation is a single READ COMMITTED transaction that:
 *  1. claims its idempotency key (INSERT … ON CONFLICT DO NOTHING) — a concurrent duplicate
 *     blocks on the unique index and then sees the key as taken, so it is applied once;
 *  2. checks the leader fence (shared lock);
 *  3. locks the user's account row (SELECT … FOR UPDATE) before reading the balance, so two
 *     concurrent bets can never spend the same money; the CHECK (balance >= 0) backs it up;
 *  4. writes balanced postings (a deferred trigger rejects the commit otherwise), the bet row
 *     change and the outbox event — all or nothing.
 */
export class PostgresLedger implements BetLedger {
  private system: Record<SystemKind, string> | null = null;

  constructor(private readonly ds: DataSource) {}

  async init(): Promise<void> {
    const rows: Array<{ id: string; kind: SystemKind }> = await this.ds.query(
      `SELECT id, kind FROM accounts WHERE kind <> 'user'`,
    );
    this.system = Object.fromEntries(rows.map((r) => [r.kind, r.id])) as Record<SystemKind, string>;
  }

  private get sys(): Record<SystemKind, string> {
    if (!this.system) throw new Error('PostgresLedger.init() not called');
    return this.system;
  }

  // ── users ────────────────────────────────────────────────────────────────

  /** Creates a user with its account and an initial play-money grant, atomically. */
  async createUser(params: {
    username: string;
    grantCents: number;
    isBot?: boolean;
    passwordHash?: string | null;
    externalId?: string | null;
  }): Promise<{ userId: string; accountId: string; balance: number }> {
    return withTransaction(this.ds, async (q) => {
      const [user] = await q.query(
        `INSERT INTO users (username, password_hash, external_id, is_bot) VALUES ($1, $2, $3, $4) RETURNING id`,
        [params.username, params.passwordHash ?? null, params.externalId ?? null, params.isBot ?? false],
      );
      const [acc] = await q.query(`INSERT INTO accounts (kind, user_id, balance) VALUES ('user', $1, 0) RETURNING id`, [user.id]);
      if (params.grantCents > 0) await this.grantIn(q, user.id, params.grantCents, `grant:signup:${user.id}`);
      return { userId: user.id, accountId: acc.id, balance: params.grantCents };
    });
  }

  /** Play-money top-up ("refill"), idempotent on `idempotencyKey`. */
  async grant(userId: string, amount: number, idempotencyKey: string): Promise<number> {
    return withTransaction(this.ds, (q) => this.grantIn(q, userId, amount, idempotencyKey));
  }

  private async grantIn(q: QueryRunner, userId: string, amount: number, idempotencyKey: string): Promise<number> {
    const txId = await this.claimKey(q, 'GRANT', idempotencyKey, null, null);
    const account = await this.lockUserAccount(q, userId);
    if (!txId) return account.balance;
    const [row] = await updateReturning<{ balance: string }>(q, `UPDATE accounts SET balance = balance + $2 WHERE id = $1 RETURNING balance`, [account.id, amount]);
    await this.post(q, txId, [
      [this.sys.mint, -amount],
      [account.id, amount],
    ]);
    return num(row!.balance);
  }

  async balanceOf(userId: string): Promise<number> {
    const [row] = await this.ds.query(`SELECT balance FROM accounts WHERE user_id = $1`, [userId]);
    if (!row) throw new Error(`unknown user ${userId}`);
    return num(row.balance);
  }

  // ── BetLedger ────────────────────────────────────────────────────────────

  async debitStake(op: StakeDebit): Promise<DebitResult> {
    return withTransactionOr<DebitResult>(this.ds, async (q) => {
      const txId = await this.claimKey(q, 'BET', op.idempotencyKey, op.roundId, op.betId);
      if (!txId) return { ok: true, balance: null }; // already applied by an earlier attempt
      await assertFence(q, op.fencingToken);

      let balance: number | null = null;
      if (!op.externalHoldId) {
        const account = await this.lockUserAccount(q, op.userId);
        if (account.balance < op.amount) throw new Rollback<DebitResult>({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
        const [row] = await updateReturning<{ balance: string }>(q, `UPDATE accounts SET balance = balance - $2 WHERE id = $1 RETURNING balance`, [account.id, op.amount]);
        await this.post(q, txId, [
          [account.id, -op.amount],
          [this.sys.escrow, op.amount],
        ]);
        balance = num(row!.balance);
      }
      // With an external hold the money is already reserved in platform-core: record the bet only.
      await q.query(
        `INSERT INTO bets (id, round_id, user_id, amount, auto_x100, client_key, placed_at, external_hold_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [op.betId, op.roundId, op.userId, op.amount, op.autoX100, op.clientKey, op.placedAt, op.externalHoldId ?? null],
      );
      await appendOutbox(q, TOPICS.betPlaced, op.roundId, {
        betId: op.betId,
        roundId: op.roundId,
        userId: op.userId,
        amount: op.amount,
        autoX100: op.autoX100,
        placedAt: op.placedAt,
      });
      return { ok: true, balance };
    });
  }

  async creditCashout(op: CashoutCredit): Promise<number | null> {
    return withTransaction(this.ds, async (q) => {
      const txId = await this.claimKey(q, 'CASHOUT', op.idempotencyKey, op.roundId, op.betId);
      if (!txId) return null;
      await assertFence(q, op.fencingToken);

      let balance: number | null = null;
      const external = await this.externalHold(q, op.betId);
      if (external) {
        // Platform-backed stake: the decision commits here, the money moves in Core via the worker.
        await this.queueSettlement(q, op.betId, external, op.payout);
      } else {
        const account = await this.lockUserAccount(q, op.userId);
        const [row] = await updateReturning<{ balance: string }>(q, `UPDATE accounts SET balance = balance + $2 WHERE id = $1 RETURNING balance`, [account.id, op.payout]);
        const profit = op.payout - op.stake;
        await this.post(q, txId, [
          [this.sys.escrow, -op.stake],
          [this.sys.house, -profit],
          [account.id, op.payout],
        ]);
        balance = num(row!.balance);
      }
      const res = await q.query(
        `UPDATE bets SET status = 'CASHED_OUT', cashout_x100 = $2, payout = $3, auto_cashout = $4, cashed_at = $5
         WHERE id = $1 AND status = 'ACTIVE'`,
        [op.betId, op.x100, op.payout, op.auto, op.cashedAt],
      );
      if (res[1] !== 1) throw new Error(`bet ${op.betId} is not ACTIVE`);
      await appendOutbox(q, TOPICS.betCashedOut, op.roundId, {
        betId: op.betId,
        roundId: op.roundId,
        userId: op.userId,
        cashoutX100: op.x100,
        payout: op.payout,
        auto: op.auto,
        cashedAt: op.cashedAt,
      });
      return balance;
    });
  }

  async settleLosses(roundId: number, lost: LostStake[], idempotencyKey: string, fencingToken: number): Promise<void> {
    if (lost.length === 0) return;
    await withTransaction(this.ds, async (q) => {
      const txId = await this.claimKey(q, 'ROUND_LOSS', idempotencyKey, roundId, null);
      if (!txId) return;
      await assertFence(q, fencingToken);
      const externals: Array<{ id: string; external_hold_id: string; external_id: string }> = await q.query(
        `SELECT b.id, b.external_hold_id, u.external_id FROM bets b JOIN users u ON u.id = b.user_id
         WHERE b.id = ANY($1::uuid[]) AND b.external_hold_id IS NOT NULL`,
        [lost.map((l) => l.betId)],
      );
      const external = new Set(externals.map((e) => e.id));
      const total = lost.filter((l) => !external.has(l.betId)).reduce((s, l) => s + l.amount, 0);
      if (total > 0) {
        await this.post(q, txId, [
          [this.sys.escrow, -total],
          [this.sys.house, total],
        ]);
      }
      // Lost platform stakes: capture into Core's house with no payout.
      for (const e of externals) await this.queueSettlement(q, e.id, { holdId: e.external_hold_id, externalUser: e.external_id }, 0);
      const res = await q.query(`UPDATE bets SET status = 'LOST', payout = 0 WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`, [
        lost.map((l) => l.betId),
      ]);
      if (res[1] !== lost.length) throw new Error(`round ${roundId}: expected ${lost.length} ACTIVE bets to lose, found ${res[1]}`);
    });
  }

  // ── audit ────────────────────────────────────────────────────────────────

  async audit(): Promise<LedgerAudit> {
    const [totals] = await this.ds.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS postings,
              (SELECT COUNT(*) FROM ledger_transactions) AS transactions
       FROM postings`,
    );
    const mismatches = await this.ds.query(
      `SELECT a.id, a.balance AS cached, COALESCE(SUM(p.amount), 0) AS computed
       FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
       WHERE a.kind = 'user'
       GROUP BY a.id, a.balance
       HAVING a.balance <> COALESCE(SUM(p.amount), 0)`,
    );
    const kinds = await this.ds.query(
      `SELECT a.kind, COALESCE(SUM(p.amount), 0) AS balance
       FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
       GROUP BY a.kind`,
    );
    const by = Object.fromEntries(kinds.map((k: { kind: string; balance: string }) => [k.kind, num(k.balance)]));
    return {
      totalPostings: num(totals.total),
      transactions: num(totals.transactions),
      postings: num(totals.postings),
      cacheMismatches: mismatches.map((m: { id: string; cached: string; computed: string }) => ({
        accountId: m.id,
        cached: num(m.cached),
        computed: num(m.computed),
      })),
      balances: { escrow: by.escrow ?? 0, house: by.house ?? 0, mint: by.mint ?? 0, users: by.user ?? 0 },
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Returns the new transaction id, or null if the key was already used (idempotent replay). */
  private async claimKey(
    q: QueryRunner,
    type: 'GRANT' | 'BET' | 'CASHOUT' | 'ROUND_LOSS',
    key: string,
    roundId: number | null,
    betId: string | null,
  ): Promise<string | null> {
    const rows = await q.query(
      `INSERT INTO ledger_transactions (type, idempotency_key, round_id, bet_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [type, key, roundId, betId],
    );
    return rows[0]?.id ?? null;
  }

  private async externalHold(q: QueryRunner, betId: string): Promise<{ holdId: string; externalUser: string } | null> {
    const [row] = await q.query(
      `SELECT b.external_hold_id, u.external_id FROM bets b JOIN users u ON u.id = b.user_id WHERE b.id = $1`,
      [betId],
    );
    return row?.external_hold_id ? { holdId: row.external_hold_id, externalUser: row.external_id } : null;
  }

  private async queueSettlement(q: QueryRunner, betId: string, hold: { holdId: string; externalUser: string }, payout: number): Promise<void> {
    await q.query(
      `INSERT INTO platform_settlements (bet_id, hold_id, external_user, payout, idempotency_key)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (bet_id) DO NOTHING`,
      [betId, hold.holdId, hold.externalUser, payout, `ronin:settle:${betId}`],
    );
  }

  private async lockUserAccount(q: QueryRunner, userId: string): Promise<{ id: string; balance: number }> {
    const [row] = await q.query(`SELECT id, balance FROM accounts WHERE user_id = $1 FOR UPDATE`, [userId]);
    if (!row) throw new Error(`unknown user ${userId}`);
    return { id: row.id, balance: num(row.balance) };
  }

  private async post(q: QueryRunner, txId: string, legs: Array<[accountId: string, amount: number]>): Promise<void> {
    const nonZero = legs.filter(([, a]) => a !== 0);
    const values = nonZero.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
    await q.query(`INSERT INTO postings (transaction_id, account_id, amount) VALUES ${values}`, [
      txId,
      ...nonZero.flatMap(([acc, amt]) => [acc, amt]),
    ]);
  }
}
