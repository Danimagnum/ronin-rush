import type { DataSource } from 'typeorm';
import type { BetLedger, CashoutCredit, DebitResult, LostStake, StakeDebit } from '../round/ports';
import type { PostgresLedger } from '../wallet/postgres-ledger';
import { CoreError, type CoreClient } from './core-client';

export interface PlatformLedgerOptions {
  houseAccountId: string;
  onError?: (e: unknown) => void;
}

interface PendingSettlement {
  bet_id: string;
  hold_id: string;
  payout: string;
  idempotency_key: string;
  attempts: number;
  user_id: string;
  external_user: string;
}

/**
 * PLATFORM_MODE wallet: platform-core owns players' money, Ronin owns the game decisions.
 *
 *  bet       Core: create a `stake` hold (Core enforces KYC, exclusion and loss limits in the same
 *            transaction) → Ronin: record the bet with the hold id. If recording fails, the hold
 *            is released (compensation).
 *  cash-out  Ronin: commit the decision + a PENDING settlement row (one transaction)
 *            → Core: capture the hold into the house with payout = stake × multiplier.
 *  loss      Ronin: commit LOST + PENDING settlement → Core: capture with payout 0.
 *
 * Captures are idempotent (`ronin:capture:<betId>`), tried immediately and then by `tick()` with
 * backoff, so a slow or unavailable Core never blocks a round or undoes a decision.
 * Users without a platform identity (bots) keep using the local double-entry ledger.
 */
export class PlatformLedger implements BetLedger {
  private readonly externalIds = new Map<string, string | null>();
  private readonly accounts = new Map<string, { id: string; at: number }>();
  private ticking = false;
  settled = 0;
  /** Pushes a player's new platform balance to their sockets (wired by the round runner). */
  onBalance: ((userId: string, balance: number) => void) | null = null;

  constructor(
    private readonly ds: DataSource,
    private readonly local: PostgresLedger,
    readonly core: CoreClient,
    private readonly opts: PlatformLedgerOptions,
  ) {}

  async debitStake(op: StakeDebit): Promise<DebitResult> {
    const external = await this.externalId(op.userId);
    if (!external) return this.local.debitStake(op);

    let accountId: string | undefined;
    let holdId: string;
    try {
      const account = await this.stakeAccount(external);
      if (!account) return { ok: false, reason: 'WALLET_UNAVAILABLE' };
      accountId = account;
      // Same key on every retry of this bet, so Core reserves the money at most once.
      const hold = await this.core.createStakeHold(accountId, op.amount, `ronin:${op.roundId}:${op.betId}`, `ronin:hold:${op.idempotencyKey}`);
      holdId = hold.id;
    } catch (e) {
      // Ambiguous outcome (timeout, 5xx): Core may have reserved the money anyway. Replaying the
      // same key returns that hold (or creates one), which is then released: net effect zero.
      if (e instanceof CoreError && e.retriable && accountId) void this.abandonHold(accountId, op);
      return { ok: false, reason: debitFailure(e) };
    }

    try {
      await this.local.debitStake({ ...op, externalHoldId: holdId });
    } catch (e) {
      // Ronin could not take the bet (e.g. fenced out): give the money back.
      await this.core.releaseHold(holdId, `ronin:release:${op.betId}`).catch((err) => this.opts.onError?.(err));
      throw e;
    }
    return { ok: true, balance: await this.balance(external) };
  }

  async creditCashout(op: CashoutCredit): Promise<number | null> {
    const localBalance = await this.local.creditCashout(op);
    if (localBalance !== null || !(await this.externalId(op.userId))) return localBalance;
    // Fast path: settle now; on failure the row stays PENDING for tick().
    return this.settleBet(op.betId);
  }

  async settleLosses(roundId: number, lost: LostStake[], idempotencyKey: string, fencingToken: number): Promise<void> {
    await this.local.settleLosses(roundId, lost, idempotencyKey, fencingToken);
    void this.tick();
  }

  /** Retries every due settlement. Safe on all instances at once (rows are leased). */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due: PendingSettlement[] = await this.ds.query(
        `UPDATE platform_settlements s SET next_attempt_at = now() + interval '30 seconds'
         FROM bets b
         WHERE s.bet_id = b.id AND s.bet_id IN (
           SELECT bet_id FROM platform_settlements WHERE status = 'PENDING' AND next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT 50 FOR UPDATE SKIP LOCKED)
         RETURNING s.bet_id, s.hold_id, s.payout, s.idempotency_key, s.attempts, s.external_user, b.user_id`,
      ).then((r: [PendingSettlement[], number] | PendingSettlement[]) => (Array.isArray(r[0]) ? (r[0] as PendingSettlement[]) : (r as PendingSettlement[])));
      let n = 0;
      for (const s of due) if ((await this.capture(s)) !== undefined) n++;
      return n;
    } finally {
      this.ticking = false;
    }
  }

  async pending(): Promise<number> {
    const [row] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM platform_settlements WHERE status = 'PENDING'`);
    return row.n;
  }

  /** Current platform balance of a local user, or null for local-only users. */
  async balanceOf(userId: string): Promise<number | null> {
    const external = await this.externalId(userId);
    if (!external) return null;
    const account = await this.core.stakeAccount(external);
    return account ? Number(account.balance) : 0;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async settleBet(betId: string): Promise<number | null> {
    const [s]: PendingSettlement[] = await this.ds.query(
      `SELECT s.bet_id, s.hold_id, s.payout, s.idempotency_key, s.attempts, s.external_user, b.user_id
       FROM platform_settlements s JOIN bets b ON b.id = s.bet_id WHERE s.bet_id = $1 AND s.status = 'PENDING'`,
      [betId],
    );
    if (!s) return null;
    return (await this.capture(s)) ?? null;
  }

  /** Captures one hold; returns the player's new balance, or undefined when it must be retried. */
  private async capture(s: PendingSettlement): Promise<number | undefined> {
    try {
      await this.core.captureHold(s.hold_id, this.opts.houseAccountId, Number(s.payout), s.idempotency_key);
      await this.ds.query(`UPDATE platform_settlements SET status = 'DONE', settled_at = now(), last_error = NULL WHERE bet_id = $1`, [s.bet_id]);
      this.settled++;
      const balance = await this.balance(s.external_user);
      if (balance !== null) this.onBalance?.(s.user_id, balance);
      return balance ?? 0;
    } catch (e) {
      const attempts = s.attempts + 1;
      const delayS = Math.min(300, 2 ** Math.min(attempts, 8));
      await this.ds
        .query(
          `UPDATE platform_settlements SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE bet_id = $1`,
          [s.bet_id, attempts, String((e as Error).message).slice(0, 500), delayS],
        )
        .catch(() => undefined);
      this.opts.onError?.(e);
      return undefined;
    }
  }

  private async abandonHold(accountId: string, op: StakeDebit): Promise<void> {
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      const hold = await this.core.createStakeHold(accountId, op.amount, `ronin:${op.roundId}:${op.betId}`, `ronin:hold:${op.idempotencyKey}`);
      await this.core.releaseHold(hold.id, `ronin:release:${op.betId}`);
    } catch (e) {
      this.opts.onError?.(e);
    }
  }

  private async externalId(userId: string): Promise<string | null> {
    if (this.externalIds.has(userId)) return this.externalIds.get(userId)!;
    const [row] = await this.ds.query(`SELECT external_id FROM users WHERE id = $1`, [userId]);
    const ext: string | null = row?.external_id ?? null;
    this.externalIds.set(userId, ext);
    return ext;
  }

  private async stakeAccount(external: string): Promise<string | null> {
    const cached = this.accounts.get(external);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.id;
    const account = await this.core.stakeAccount(external);
    if (account) this.accounts.set(external, { id: account.id, at: Date.now() });
    return account?.id ?? null;
  }

  private async balance(external: string): Promise<number | null> {
    try {
      const account = await this.core.stakeAccount(external);
      return account ? Number(account.balance) : null;
    } catch {
      return null; // the balance push is a nicety; the money movement already succeeded
    }
  }
}

/** Maps a Core refusal to the game's error codes. Nothing has been charged in any of these cases. */
export function debitFailure(e: unknown): 'INSUFFICIENT_FUNDS' | 'RESPONSIBLE_GAMING_BLOCKED' | 'WALLET_UNAVAILABLE' {
  if (e instanceof CoreError) {
    if (e.status === 422 && /insufficient/i.test(e.code)) return 'INSUFFICIENT_FUNDS';
    if (e.status === 403) return 'RESPONSIBLE_GAMING_BLOCKED';
  }
  return 'WALLET_UNAVAILABLE';
}
