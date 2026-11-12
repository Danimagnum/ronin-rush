import type { DataSource } from 'typeorm';
import type { BetLedger, CashoutCredit, DebitResult, LostStake, StakeDebit } from '../round/ports';
import type { PostgresLedger } from '../wallet/postgres-ledger';
import { CoreError, type CoreClient } from './core-client';

export interface PlatformLedgerOptions {
  /** How long a stake hold lives in Core. Settlement is possible 1800 s beyond it (fixed by Core). */
  holdTtlSeconds?: number;
  /** Wait before unwinding an ambiguous stake, so a late in-flight request lands first. Default 2000. */
  abandonDelayMs?: number;
  /** Minimum time between activation attempts for the same player. Default 5000. */
  activationCooldownMs?: number;
  onError?: (e: unknown) => void;
}

/** Core answers that no retry can fix: the settlement is marked FAILED for a human instead of looping. */
const PERMANENT = new Set([
  'settlement_grace_expired',
  'hold_expired',
  'hold_not_found',
  'invalid_hold_state',
  'invalid_settlement_purpose',
  'settlement_forbidden',
  'settlement_intent_conflict',
  'invalid_commission',
  'currency_mismatch',
  'currency_not_supported',
  'idempotency_conflict',
]);

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
 *  entry     The player's own session token activates Ronin in Core once (explicit grant for this
 *            player and this service) and returns their wallet id (`ensureWallet`).
 *  bet       Core: createHold (stake; Core enforces KYC, exclusion and loss limits in that
 *            transaction) -> registerHoldSettlementIntent (reserves the settlement window; the bet is
 *            NOT accepted before Core confirms it) -> Ronin records the bet with the hold id.
 *            If any later step fails, the stake is given back (settle `void`, or release).
 *  cash-out  Ronin: commit the decision + a PENDING settlement row (one transaction)
 *            -> Core settleHold: capture the stake into the house and pay stake x multiplier (gross).
 *  loss      Ronin: commit LOST + PENDING settlement -> Core settleHold with payout 0.
 *
 * Settlements are idempotent (`ronin:settle:<betId>`), tried immediately and then by `tick()` with
 * backoff, so a slow or unavailable Core never blocks a round or undoes a decision. Core keeps the
 * stake held for 1800 s beyond the hold's expiry once the intention exists; an answer that can never
 * succeed (grace expired) parks the row as FAILED for reconciliation. Users without a platform
 * identity (bots) keep using the local double-entry ledger.
 */
export class PlatformLedger implements BetLedger {
  private readonly externalIds = new Map<string, string | null>();
  private readonly wallets = new Map<string, string>();
  private readonly activationTried = new Map<string, number>();
  private ticking = false;
  settled = 0;
  failed = 0;
  /** Pushes a player's new platform balance to their sockets (wired by the round runner). */
  onBalance: ((userId: string, balance: number) => void) | null = null;

  constructor(
    private readonly ds: DataSource,
    private readonly local: PostgresLedger,
    readonly core: CoreClient,
    private readonly opts: PlatformLedgerOptions = {},
  ) {}

  /**
   * Runs at authenticated entry with the player's own token. Never throws: a Core outage must not
   * lock a player out of watching; betting simply stays unavailable until activation succeeds.
   */
  async ensureWallet(userId: string, subject: string, playerToken: string): Promise<string | null> {
    const cached = this.wallets.get(userId);
    if (cached) return cached;
    const [row] = await this.ds.query(`SELECT external_wallet_id FROM users WHERE id = $1`, [userId]);
    if (row?.external_wallet_id) {
      this.wallets.set(userId, row.external_wallet_id);
      return row.external_wallet_id;
    }
    const last = this.activationTried.get(userId) ?? 0;
    if (Date.now() - last < (this.opts.activationCooldownMs ?? 5_000)) return null;
    this.activationTried.set(userId, Date.now());
    try {
      const walletId = await this.core.activatePlayer(playerToken, subject);
      await this.ds.query(`UPDATE users SET external_wallet_id = $2 WHERE id = $1`, [userId, walletId]);
      this.wallets.set(userId, walletId);
      return walletId;
    } catch (e) {
      this.opts.onError?.(e);
      return null;
    }
  }

  async debitStake(op: StakeDebit): Promise<DebitResult> {
    const external = await this.externalId(op.userId);
    if (!external) return this.local.debitStake(op);

    const walletId = await this.walletId(op.userId);
    if (!walletId) return { ok: false, reason: 'WALLET_UNAVAILABLE' };
    const reference = `ronin:${op.roundId}:${op.betId}`;
    // Deterministic from the bet, so a retry of the same bet sends the identical request.
    const expiresAt = new Date(op.placedAt + (this.opts.holdTtlSeconds ?? 3_600) * 1_000).toISOString();

    let holdId: string;
    try {
      // Same key on every retry of this bet, so Core reserves the money at most once.
      holdId = (await this.core.createStakeHold(walletId, op.amount, reference, expiresAt, `ronin:hold:${op.idempotencyKey}`)).holdId;
    } catch (e) {
      // Ambiguous outcome (timeout, 5xx): Core may have reserved the money anyway.
      if (e instanceof CoreError && e.retriable) void this.abandon(walletId, op, reference, expiresAt);
      return { ok: false, reason: debitFailure(e) };
    }

    try {
      await this.core.registerIntent(holdId, settlementId(op.betId), `ronin:intent:${op.betId}`);
    } catch (e) {
      // No confirmed settlement window = no bet. Definitive refusal: release now; ambiguous: the
      // intention may exist, so unwind through the idempotent void path instead.
      if (e instanceof CoreError && !e.retriable) await this.core.releaseHold(holdId, `ronin:release:${op.betId}`).catch((err) => this.opts.onError?.(err));
      else void this.abandon(walletId, op, reference, expiresAt);
      return { ok: false, reason: 'WALLET_UNAVAILABLE' };
    }

    try {
      await this.local.debitStake({ ...op, externalHoldId: holdId });
    } catch (e) {
      // Ronin could not take the bet (e.g. fenced out): give the money back.
      await this.void(holdId, op).catch((err) => this.opts.onError?.(err));
      throw e;
    }
    return { ok: true, balance: await this.balance(walletId) };
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
    const walletId = await this.walletId(userId);
    return walletId ? this.core.available(walletId) : 0;
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

  /** Settles one hold; returns the player's new balance, or undefined when it must be retried. */
  private async capture(s: PendingSettlement): Promise<number | undefined> {
    const payout = Number(s.payout);
    const result = payout > 0 ? 'cash-out' : 'loss';
    try {
      try {
        await this.core.settle(s.hold_id, result, payout, s.idempotency_key, settlementId(s.bet_id));
      } catch (e) {
        // A hold from before the intention flow, or an intention whose registration was lost:
        // register it (still inside the window or this fails for good) and settle once more.
        if (!(e instanceof CoreError) || e.code !== 'settlement_intent_required') throw e;
        await this.core.registerIntent(s.hold_id, settlementId(s.bet_id), `ronin:intent:${s.bet_id}`);
        await this.core.settle(s.hold_id, result, payout, s.idempotency_key, settlementId(s.bet_id));
      }
      await this.ds.query(`UPDATE platform_settlements SET status = 'DONE', settled_at = now(), last_error = NULL WHERE bet_id = $1`, [s.bet_id]);
      this.settled++;
      const balance = await this.balance(await this.walletId(s.user_id));
      if (balance !== null) this.onBalance?.(s.user_id, balance);
      return balance ?? 0;
    } catch (e) {
      const permanent = e instanceof CoreError && PERMANENT.has(e.code);
      const attempts = s.attempts + 1;
      const delayS = Math.min(300, 2 ** Math.min(attempts, 8));
      await this.ds
        .query(
          `UPDATE platform_settlements SET attempts = $2, last_error = $3, status = $5, next_attempt_at = now() + make_interval(secs => $4) WHERE bet_id = $1`,
          [s.bet_id, attempts, String((e as Error).message).slice(0, 500), delayS, permanent ? 'FAILED' : 'PENDING'],
        )
        .catch(() => undefined);
      if (permanent) this.failed++;
      this.opts.onError?.(e);
      return undefined;
    }
  }

  /** Stake back to the player once an intention exists: capture and pay the same amount, atomically. */
  private async void(holdId: string, op: StakeDebit): Promise<void> {
    await this.core.settle(holdId, 'void', op.amount, `ronin:void:${op.betId}`, settlementId(op.betId));
  }

  /**
   * Unwinds a stake whose outcome is unknown. Replaying the hold request with its own key returns
   * the hold if Core made it (or makes it); the intention and the void are idempotent too, so the
   * net effect is zero whatever Core had already committed.
   */
  private async abandon(walletId: string, op: StakeDebit, reference: string, expiresAt: string): Promise<void> {
    await new Promise((r) => setTimeout(r, this.opts.abandonDelayMs ?? 2_000));
    try {
      const hold = await this.core.createStakeHold(walletId, op.amount, reference, expiresAt, `ronin:hold:${op.idempotencyKey}`);
      await this.core.registerIntent(hold.holdId, settlementId(op.betId), `ronin:intent:${op.betId}`);
      await this.void(hold.holdId, op);
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

  private async walletId(userId: string): Promise<string | null> {
    const cached = this.wallets.get(userId);
    if (cached) return cached;
    const [row] = await this.ds.query(`SELECT external_wallet_id FROM users WHERE id = $1`, [userId]);
    if (row?.external_wallet_id) this.wallets.set(userId, row.external_wallet_id);
    return row?.external_wallet_id ?? null;
  }

  private async balance(walletId: string | null): Promise<number | null> {
    if (!walletId) return null;
    try {
      return await this.core.available(walletId);
    } catch {
      return null; // the balance push is a nicety; the money movement already succeeded
    }
  }
}

/** Stable business id of a bet's settlement, registered in Core before the bet is accepted. */
export const settlementId = (betId: string): string => `ronin:bet:${betId}`;

/** Maps a Core refusal to the game's error codes. Nothing has been charged in any of these cases. */
export function debitFailure(e: unknown): 'INSUFFICIENT_FUNDS' | 'RESPONSIBLE_GAMING_BLOCKED' | 'WALLET_UNAVAILABLE' {
  if (e instanceof CoreError) {
    if (e.code === 'insufficient_funds') return 'INSUFFICIENT_FUNDS';
    if (['account_restricted', 'loss_limit_exceeded', 'kyc_required', 'forbidden'].includes(e.code)) return 'RESPONSIBLE_GAMING_BLOCKED';
  }
  return 'WALLET_UNAVAILABLE';
}
