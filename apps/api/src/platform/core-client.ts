import { createClientCredentialsProvider } from '@danigil/platform-contracts';
import { WalletApiError, WalletClient } from '@danigil/platform-contracts/wallet';

/**
 * Client for platform-core's /api/v1 wallet (OpenAPI 1.2.0, @danigil/platform-contracts 0.3.0).
 *
 *  - Player wallet: Core resolves it when the PLAYER activates the service with their own session
 *    token (POST /v1/services/{id}/activate): Core creates the explicit per-wallet grant and
 *    returns the walletId. No SQL, no machine-token self-service.
 *  - Money: createHold (stake) -> registerHoldSettlementIntent (before the bet is accepted) ->
 *    settleHold (capture + gross payout in one Core transaction, commission 0) or releaseHold.
 *  - Service token: createClientCredentialsProvider (wallet:read, wallet:write), cached, renewed
 *    before expiry, concurrent grants shared; forced renewal once on a 401 (inside WalletClient).
 *  - Every write sends a stable Idempotency-Key. Ambiguous failures (network, timeout, 5xx, 429,
 *    409 idempotency_in_progress) are retried with the SAME key and body, so Core applies the
 *    write at most once and replays the original response.
 *  - Amounts are integer strings in minor units (EUR cents), Ronin's cents map 1:1.
 */
export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`platform-core ${status} ${code}: ${message}`);
    this.name = 'CoreError';
  }

  /** Worth retrying with the same idempotency key. */
  get retriable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500 || this.code === 'idempotency_in_progress';
  }
}

export interface CoreHold {
  holdId: string;
  walletId: string;
  status: string;
  expiresAt: string;
}

export interface CoreIntent {
  settlementId: string;
  status: 'pending';
  settleBefore: string;
}

export interface CoreReceipt {
  settlementId: string;
  status: 'settled';
  result: string;
  capturedAmount: string;
  payoutAmount: string;
  commissionAmount: string;
  netPayoutAmount: string;
  transactionIds: string[];
}

export interface CoreClientOptions {
  baseUrl: string;
  /** Defaults to baseUrl + /oauth/token. */
  tokenUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Service id used to activate players ("ronin" in Core's provisioning). Defaults to clientId. */
  serviceId?: string;
  /** Wallet currency used by Ronin stakes (Core 0.2.0 supports EUR only). */
  currency: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Scopes of the `ronin` client in Core's provisioning for /api/v1 (no legacy scopes needed). */
export const CORE_SCOPES = ['wallet:read', 'wallet:write'] as const;

export class CoreClient {
  private readonly wallet: WalletClient;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Latency of recent calls, for the System view. */
  readonly latencies: number[] = [];
  calls = 0;
  failures = 0;

  constructor(private readonly opts: CoreClientOptions) {
    this.fetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const token = createClientCredentialsProvider({
      tokenUrl: opts.tokenUrl ?? this.url('/oauth/token'),
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      scopes: CORE_SCOPES,
      fetch: this.fetch,
    });
    this.wallet = new WalletClient({
      baseUrl: this.url('/api/v1'),
      token,
      fetch: this.fetch,
      retries: opts.retries ?? 3,
      timeoutMs: opts.timeoutMs ?? 3_000,
      sleep: this.sleep,
    });
  }

  get currency(): string {
    return this.opts.currency;
  }

  get serviceId(): string {
    return this.opts.serviceId ?? this.opts.clientId;
  }

  // ── wallet ─────────────────────────────────────────────────────────────

  /**
   * First entry of a player: Core verifies the PLAYER's live session token, creates the explicit
   * grant for this player and this service only, and returns the EUR cash wallet id. Repeating it
   * with the same key is safe. A machine token cannot do this on behalf of a player.
   */
  async activatePlayer(playerToken: string, subject: string): Promise<string> {
    const started = Date.now();
    this.calls++;
    const key = `ronin:activate:${subject}`;
    try {
      for (let attempt = 0; ; attempt++) {
        let err: CoreError;
        try {
          const res = await this.fetch(this.url(`/v1/services/${encodeURIComponent(this.serviceId)}/activate`), {
            method: 'POST',
            headers: { authorization: `Bearer ${playerToken}`, 'content-type': 'application/json', 'idempotency-key': key, accept: 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3_000),
          });
          if (res.ok) {
            const out = (await res.json()) as { wallets?: { walletId: string; currency: string; canWrite: boolean }[] };
            const w = out.wallets?.find((x) => x.currency === this.opts.currency && x.canWrite);
            if (!w) throw new CoreError(422, 'wallet_not_granted', `no writable ${this.opts.currency} wallet in the activation response`);
            return w.walletId;
          }
          const payload = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
          err = new CoreError(res.status, payload.code ?? 'error', payload.message ?? res.statusText);
        } catch (e) {
          err = e instanceof CoreError ? e : new CoreError(0, 'network_error', (e as Error).message);
        }
        if (!err.retriable || attempt >= (this.opts.retries ?? 3)) throw err;
        await this.sleep(100 * 2 ** (attempt + 1));
      }
    } catch (e) {
      this.failures++;
      throw e;
    } finally {
      this.record(Date.now() - started);
    }
  }

  /** Spendable balance (ledger minus holds) in minor units. */
  async available(walletId: string): Promise<number> {
    const b = await this.api(() => this.wallet.call('getWalletBalance', { walletId }, undefined));
    return Number(b.available);
  }

  /** Reserves the stake. Core checks KYC, exclusion and loss limits inside the same transaction. */
  createStakeHold(walletId: string, amount: number, reference: string, expiresAt: string, idempotencyKey: string): Promise<CoreHold> {
    return this.api(() =>
      this.wallet.call(
        'createHold',
        { walletId },
        { money: { amount: String(amount), currency: this.opts.currency }, reference, expiresAt, purpose: 'stake' },
        { idempotencyKey, correlationId: reference },
      ),
    );
  }

  /** Reserves Core's settlement window for this stake. Must succeed BEFORE the bet is accepted. */
  registerIntent(holdId: string, settlementId: string, idempotencyKey: string): Promise<CoreIntent> {
    return this.api(() => this.wallet.call('registerHoldSettlementIntent', { holdId }, { settlementId }, { idempotencyKey, correlationId: settlementId }));
  }

  /** Captures the stake into the house and pays `payout` (gross, 0 for a lost bet) to the player, atomically. */
  settle(holdId: string, result: string, payout: number, idempotencyKey: string, correlationId?: string): Promise<CoreReceipt> {
    return this.api(() =>
      this.wallet.call(
        'settleHold',
        { holdId },
        { result, payoutAmount: String(payout), commissionAmount: '0', asset: this.opts.currency as 'EUR' },
        { idempotencyKey, ...(correlationId ? { correlationId } : {}) },
      ),
    );
  }

  /** Returns a hold that has NO settlement intention (Core refuses a release once one exists). */
  releaseHold(holdId: string, idempotencyKey: string): Promise<CoreHold> {
    return this.api(() => this.wallet.call('releaseHold', { holdId }, undefined, { idempotencyKey }));
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private async api<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.calls++;
    try {
      return await fn();
    } catch (e) {
      this.failures++;
      if (e instanceof WalletApiError) throw new CoreError(e.status, e.code, e.message);
      throw new CoreError(0, 'network_error', (e as Error).message);
    } finally {
      this.record(Date.now() - started);
    }
  }

  private url(path: string): string {
    return this.opts.baseUrl.replace(/\/$/, '') + path;
  }

  private record(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();
  }

  p95(): number {
    if (!this.latencies.length) return 0;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
  }
}
