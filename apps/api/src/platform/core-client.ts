/**
 * Minimal client for platform-core's wallet and responsible-gaming APIs (contract:
 * @danigil/platform-contracts, wallet OpenAPI + platform-core docs/integration.md).
 *
 *  - Service token: OAuth2 client credentials, cached until shortly before expiry.
 *  - Every write sends an Idempotency-Key. Ambiguous failures (network, timeout, 5xx, 429,
 *    409 idempotency_in_progress) are retried with the SAME key and body, so Core applies
 *    the write at most once and replays the original response.
 *  - Amounts are decimal strings in minor units; Ronin's cents map 1:1.
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

export interface CoreAccount {
  id: string;
  kind: string;
  currency: string;
  balance: string;
}

export interface CoreHold {
  id: string;
  status: string;
  transactionId?: string;
}

export interface CoreClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Wallet currency used by Ronin stakes (Core keeps one account per currency). */
  currency: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const SCOPES = 'wallet:legacy:read wallet:legacy:write';

export class CoreClient {
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPending: Promise<string> | null = null;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Latency of recent calls, for the System view. */
  readonly latencies: number[] = [];
  calls = 0;
  failures = 0;

  constructor(private readonly opts: CoreClientOptions) {
    this.fetch = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get currency(): string {
    return this.opts.currency;
  }

  // ── wallet ─────────────────────────────────────────────────────────────

  /** The player's stake account: cash first, bonus as a fallback, in Ronin's currency. */
  async stakeAccount(userId: string): Promise<CoreAccount | null> {
    const accounts = await this.call<CoreAccount[]>('GET', `/v1/wallet/accounts?userId=${encodeURIComponent(userId)}`);
    const mine = accounts.filter((a) => a.currency === this.opts.currency);
    return mine.find((a) => a.kind === 'user_cash') ?? mine.find((a) => a.kind === 'user_bonus') ?? null;
  }

  /** Reserves the stake. Core checks KYC, exclusion and loss limits inside the same transaction. */
  createStakeHold(accountId: string, amount: number, reference: string, idempotencyKey: string): Promise<CoreHold> {
    return this.call('POST', '/v1/wallet/holds', { accountId, amount: String(amount), purpose: 'stake', reference }, idempotencyKey);
  }

  /** Settles the stake into the house and pays `payout` (0 for a lost bet) back to the player, atomically. */
  captureHold(holdId: string, houseAccountId: string, payout: number, idempotencyKey: string): Promise<CoreHold> {
    return this.call(
      'POST',
      `/v1/wallet/holds/${encodeURIComponent(holdId)}/capture`,
      { toAccountId: houseAccountId, payoutAmount: String(payout) },
      idempotencyKey,
    );
  }

  /** Returns a hold to the player (compensation when Ronin could not record the bet). */
  releaseHold(holdId: string, idempotencyKey: string): Promise<CoreHold> {
    return this.call('POST', `/v1/wallet/holds/${encodeURIComponent(holdId)}/release`, undefined, idempotencyKey);
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const retries = this.opts.retries ?? 3;
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      this.calls++;
      try {
        const res = await this.once<T>(method, path, body, idempotencyKey);
        this.record(Date.now() - started);
        return res;
      } catch (e) {
        this.record(Date.now() - started);
        const err = e instanceof CoreError ? e : new CoreError(0, 'network_error', (e as Error).message);
        // A GET is always safe to retry; a write only with its idempotency key.
        const safe = method === 'GET' || Boolean(idempotencyKey);
        if (!err.retriable || !safe || attempt >= retries) {
          this.failures++;
          throw err;
        }
        if (err.status === 401) this.token = null;
        attempt++;
        await this.sleep((err as CoreError & { retryAfterMs?: number }).retryAfterMs ?? 100 * 2 ** attempt);
      }
    }
  }

  private async once<T>(method: string, path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.serviceToken()}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await this.fetch(this.url(path), {
      method,
      headers,
      body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3_000),
    });
    if (res.ok) return (await res.json()) as T;
    const payload = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    const err = new CoreError(res.status, payload.code ?? 'error', payload.message ?? res.statusText) as CoreError & { retryAfterMs?: number };
    const retryAfter = Number(res.headers.get('retry-after'));
    if (retryAfter > 0) err.retryAfterMs = Math.min(retryAfter, 5) * 1_000;
    throw err;
  }

  private async serviceToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) return this.token.value;
    // One refresh at a time, shared by concurrent callers.
    this.tokenPending ??= this.fetchToken().finally(() => (this.tokenPending = null));
    return this.tokenPending;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetch(this.url('/oauth/token'), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPES }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3_000),
    });
    if (!res.ok) throw new CoreError(res.status, 'token_error', 'client credentials rejected');
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1_000 };
    return t.access_token;
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
