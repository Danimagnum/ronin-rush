import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../src/platform/core-client';
import { PlatformLedger } from '../src/platform/platform-ledger';
import { PostgresRoundStore } from '../src/round/postgres-round-store';
import { ensureActiveChain } from '../src/round/postgres-seed-source';
import { PostgresLedger } from '../src/wallet/postgres-ledger';
import { TEST_DATABASE_URL, freshSchema } from './db';

const GRACE_MS = 1_800_000;

interface Hold {
  walletId: string;
  amount: number;
  status: 'active' | 'captured' | 'released';
  expiresAt: number;
  intent?: string;
}

/**
 * A small stand-in for platform-core's /api/v1 wallet (OpenAPI 1.2.0): client-credentials tokens,
 * player activation with the player's own token, wallets with ledger/held amounts, stake holds that
 * enforce funds and responsible-gaming blocks, settlement intentions, atomic settle with a gross
 * payout from the house, the fixed 1800 s grace, release (refused once an intention exists), and
 * idempotency-key replay that rejects a different request under the same key.
 */
class FakeCore {
  ledger = new Map<string, number>();
  held = new Map<string, number>();
  owner = new Map<string, string>(); // walletId -> subject
  playerTokens = new Map<string, string>(); // player bearer -> subject
  blocked = new Set<string>();
  holds = new Map<string, Hold>();
  replies = new Map<string, { sig: string; status: number; body: unknown }>();
  house = 0;
  settles = 0;
  down = false;
  /** One-shot faults keyed by "METHOD path-suffix": the write is APPLIED, then the response is lost. */
  dropResponse = new Map<string, number>();
  failNext = new Map<string, { status: number; code: string }>();
  clockSkew = 0;
  token = 'svc-token';
  tokenGrants = 0;
  server!: Server;

  now = (): number => Date.now() + this.clockSkew;
  available = (w: string): number => (this.ledger.get(w) ?? 0) - (this.held.get(w) ?? 0);

  addUser(subject: string, walletId: string, balance: number): string {
    this.ledger.set(walletId, balance);
    this.owner.set(walletId, subject);
    const playerToken = `player-${subject}`;
    this.playerTokens.set(playerToken, subject);
    return playerToken;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const err = (status: number, code: string) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code, message: code, correlationId: 'x' }));
        };
        const url = new URL(req.url!, 'http://core');
        if (this.down) return err(503, 'unavailable');
        if (url.pathname === '/oauth/token') {
          this.tokenGrants++;
          const scope = new URLSearchParams(raw).get('scope') ?? '';
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ access_token: this.token, token_type: 'Bearer', expires_in: 600, scope }));
        }
        const bearer = String(req.headers.authorization ?? '').replace('Bearer ', '');
        const key = String(req.headers['idempotency-key'] ?? '');
        const act = /^\/v1\/services\/([^/]+)\/activate$/.exec(url.pathname);
        const wallet = this.reply(res, req.method!, url.pathname, key, raw);

        if (act) {
          // Only a live PLAYER session may activate; the machine token is refused.
          const subject = this.playerTokens.get(bearer);
          if (!subject) return err(401, 'unauthorized');
          const walletId = [...this.owner].find(([, s]) => s === subject)?.[0];
          if (!walletId) return err(404, 'wallet_not_found');
          return wallet(201, { serviceId: act[1], wallets: [{ walletId, currency: 'EUR', canWrite: true }] });
        }
        if (bearer !== this.token) return err(401, 'invalid_token');

        const fault = [...this.failNext].find(([k]) => `${req.method} ${url.pathname}`.endsWith(k));
        if (fault) {
          this.failNext.delete(fault[0]);
          return err(fault[1].status, fault[1].code);
        }
        const drop = [...this.dropResponse.keys()].find((k) => `${req.method} ${url.pathname}`.endsWith(k));
        const reply = (status: number, body: unknown) => {
          if (drop) {
            const left = this.dropResponse.get(drop)! - 1;
            if (left > 0) this.dropResponse.set(drop, left);
            else this.dropResponse.delete(drop);
            if (status < 300) this.store(req.method!, url.pathname, key, raw, status, body);
            return req.socket.destroy(); // applied in Core, answer never arrives
          }
          return wallet(status, body);
        };

        const bal = /^\/api\/v1\/wallets\/([^/]+)\/balance$/.exec(url.pathname);
        if (req.method === 'GET' && bal) {
          const w = bal[1]!;
          if (!this.owner.has(w)) return err(404, 'wallet_not_found');
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ walletId: w, currency: 'EUR', ledger: String(this.ledger.get(w)), available: String(this.available(w)), held: String(this.held.get(w) ?? 0) }));
        }
        if (!key) return err(400, 'invalid_request');
        const replay = this.replies.get(key);
        if (replay) {
          if (drop) {
            const left = this.dropResponse.get(drop)! - 1;
            if (left > 0) this.dropResponse.set(drop, left);
            else this.dropResponse.delete(drop);
            return req.socket.destroy(); // the replay's answer is lost too
          }
          if (replay.sig !== `${req.method} ${url.pathname} ${raw}`) return err(409, 'idempotency_conflict');
          res.writeHead(replay.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(replay.body));
        }
        const body = raw ? JSON.parse(raw) : {};
        const hc = /^\/api\/v1\/wallets\/([^/]+)\/holds$/.exec(url.pathname);
        if (req.method === 'POST' && hc) {
          const w = hc[1]!;
          if (!this.owner.has(w)) return err(404, 'wallet_not_found');
          if (this.blocked.has(this.owner.get(w)!)) return err(403, 'account_restricted');
          const amount = Number(body.money.amount);
          if (this.available(w) < amount) return err(422, 'insufficient_funds');
          this.held.set(w, (this.held.get(w) ?? 0) + amount);
          const holdId = crypto.randomUUID();
          this.holds.set(holdId, { walletId: w, amount, status: 'active', expiresAt: Date.parse(body.expiresAt) });
          return reply(201, { holdId, walletId: w, money: body.money, reference: body.reference, status: 'active', expiresAt: body.expiresAt });
        }
        const hm = /^\/api\/v1\/holds\/([^/]+)\/(settlement-intent|settle|release)$/.exec(url.pathname);
        if (req.method === 'POST' && hm) {
          const hold = this.holds.get(hm[1]!);
          if (!hold) return err(404, 'hold_not_found');
          if (hold.status !== 'active') return err(409, 'invalid_hold_state');
          const settleBefore = hold.expiresAt + GRACE_MS;
          if (hm[2] === 'settlement-intent') {
            if (this.now() >= hold.expiresAt) return err(422, 'hold_expired');
            if (hold.intent && hold.intent !== body.settlementId) return err(409, 'settlement_intent_conflict');
            hold.intent = body.settlementId;
            return reply(201, { settlementId: body.settlementId, holdIds: [hm[1]], status: 'pending', registeredAt: new Date(this.now()).toISOString(), settleBefore: new Date(settleBefore).toISOString() });
          }
          if (hm[2] === 'release') {
            if (hold.intent) return err(409, 'settlement_intent_conflict');
            hold.status = 'released';
            this.held.set(hold.walletId, this.held.get(hold.walletId)! - hold.amount);
            return reply(200, { holdId: hm[1], walletId: hold.walletId, money: { amount: String(hold.amount), currency: 'EUR' }, reference: 'r', status: 'released', expiresAt: new Date(hold.expiresAt).toISOString() });
          }
          if (!hold.intent) return err(409, 'settlement_intent_required');
          if (this.now() >= settleBefore) return err(422, 'settlement_grace_expired');
          const payout = Number(body.payoutAmount);
          const commission = Number(body.commissionAmount);
          if (commission > payout) return err(422, 'invalid_commission');
          if (this.house + hold.amount < payout) return err(422, 'insufficient_funds');
          hold.status = 'captured';
          this.settles++;
          this.held.set(hold.walletId, this.held.get(hold.walletId)! - hold.amount);
          this.ledger.set(hold.walletId, this.ledger.get(hold.walletId)! - hold.amount + payout - commission);
          this.house += hold.amount - payout;
          return reply(200, {
            settlementId: hold.intent, holdIds: [hm[1]], status: 'settled', result: body.result, payoutWalletId: hold.walletId, asset: 'EUR',
            capturedAmount: String(hold.amount), payoutAmount: body.payoutAmount, commissionAmount: body.commissionAmount, netPayoutAmount: String(payout - commission), transactionIds: [crypto.randomUUID()],
          });
        }
        err(404, 'not_found');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private store(method: string, path: string, key: string, raw: string, status: number, body: unknown): void {
    if (key) this.replies.set(key, { sig: `${method} ${path} ${raw}`, status, body });
  }

  private reply(res: import('node:http').ServerResponse, method: string, path: string, key: string, raw: string) {
    return (status: number, body: unknown) => {
      this.store(method, path, key, raw, status, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  }
}

describe.skipIf(!TEST_DATABASE_URL)('PlatformLedger on /api/v1 (real PostgreSQL + fake platform-core)', () => {
  let ds: DataSource;
  let local: PostgresLedger;
  let ledger: PlatformLedger;
  const core = new FakeCore();
  const TOKEN = 1;
  let round = 0;
  const pushes: Array<[string, number]> = [];

  beforeAll(async () => {
    ds = await freshSchema('t_platform');
    local = new PostgresLedger(ds);
    await local.init();
    const url = await core.start();
    const client = new CoreClient({ baseUrl: url, clientId: 'ronin', clientSecret: 's', currency: 'EUR', retries: 1, sleep: async () => {} });
    ledger = new PlatformLedger(ds, local, client, { abandonDelayMs: 20, activationCooldownMs: 0 });
    ledger.onBalance = (u, b) => pushes.push([u, b]);
    core.house = 1_000_000;
    await ensureActiveChain(ds, { length: 50, publicSalt: 'test-salt-123' });
  });
  afterAll(async () => {
    core.server?.close();
    await ds?.destroy();
  });

  beforeEach(async () => {
    round++;
    const [chain] = await ds.query(`SELECT id FROM fairness_chains WHERE active`);
    await new PostgresRoundStore(ds, chain.id).save(
      { id: round, seedHash: 'a'.repeat(64), crashX100: 200, phase: 'BETTING', bettingEndsAt: 1, startedAt: null, crashAt: null, crashedAt: null, settledAt: null, seed: null },
      TOKEN,
      [],
    );
  });

  /** A Core player that has entered the game with their own token (activation stores the wallet). */
  async function platformUser(name: string, balance: number, activate = true) {
    const externalId = crypto.randomUUID();
    const u = await local.createUser({ username: name, externalId, grantCents: 0 });
    const walletId = crypto.randomUUID();
    const playerToken = core.addUser(externalId, walletId, balance);
    if (activate) await ledger.ensureWallet(u.userId, externalId, playerToken);
    return { ...u, externalId, walletId, playerToken };
  }

  const bet = (userId: string, amount: number, betId = crypto.randomUUID()) =>
    ledger.debitStake({ betId, userId, roundId: round, amount, autoX100: null, clientKey: betId, placedAt: Date.now(), idempotencyKey: `bet:${round}:${userId}:${betId}`, fencingToken: TOKEN });
  const holdsOf = (walletId: string) => [...core.holds.values()].filter((h) => h.walletId === walletId);
  const cashout = (betId: string, userId: string, stake: number, payout: number) =>
    ledger.creditCashout({ betId, userId, roundId: round, stake, payout, x100: 150, auto: false, cashedAt: 2, idempotencyKey: `cashout:${betId}`, fencingToken: TOKEN });

  it('activation uses the PLAYER token, stores the wallet once, and a machine token cannot do it', async () => {
    const p = await platformUser('nao', 1_000);
    const [u] = await ds.query(`SELECT external_wallet_id FROM users WHERE id = $1`, [p.userId]);
    expect(u.external_wallet_id).toBe(p.walletId);
    const lonely = await platformUser('tomo', 1_000, false);
    expect(await ledger.ensureWallet(lonely.userId, lonely.externalId, core.token)).toBeNull(); // machine bearer refused
    expect((await bet(lonely.userId, 100)).ok).toBe(false); // no wallet yet: nothing charged
    expect(await ledger.ensureWallet(lonely.userId, lonely.externalId, lonely.playerToken)).toBe(lonely.walletId);
  });

  it('reserves the stake, confirms the settlement window BEFORE recording the bet, and pays the gross cash-out', async () => {
    const p = await platformUser('aiko', 10_000);
    const postingsBefore = (await local.audit()).postings;

    expect(await bet(p.userId, 1_000)).toEqual({ ok: true, balance: 9_000 });
    const [hold] = holdsOf(p.walletId);
    expect(hold!.intent).toMatch(/^ronin:bet:/);
    const [row] = await ds.query(`SELECT id, external_hold_id FROM bets WHERE user_id = $1`, [p.userId]);
    expect(row.external_hold_id).toBeTruthy();
    expect(hold!.intent).toBe(`ronin:bet:${row.id}`);
    expect((await local.audit()).postings).toBe(postingsBefore); // money did not move locally

    expect(await cashout(row.id, p.userId, 1_000, 2_500)).toBe(11_500);
    expect(core.available(p.walletId)).toBe(11_500);
    expect((await ds.query(`SELECT status, payout, idempotency_key FROM platform_settlements WHERE bet_id = $1`, [row.id]))[0]).toEqual({ status: 'DONE', payout: '2500', idempotency_key: `ronin:settle:${row.id}` });
    expect((await ds.query(`SELECT status, payout FROM bets WHERE id = $1`, [row.id]))[0]).toEqual({ status: 'CASHED_OUT', payout: '2500' });
  });

  it('a retried bet creates one hold; Core refusals map to game errors and record nothing', async () => {
    const p = await platformUser('ren', 5_000);
    const betId = crypto.randomUUID();
    const key = `bet:${round}:${p.userId}`;
    const placedAt = Date.now();
    const again = () => ledger.debitStake({ betId, userId: p.userId, roundId: round, amount: 1_000, autoX100: null, clientKey: betId, placedAt, idempotencyKey: key, fencingToken: TOKEN });
    await again();
    await again(); // identical request: Core replays hold and intention, the local ledger replays the bet
    expect(core.available(p.walletId)).toBe(4_000);
    expect(holdsOf(p.walletId)).toHaveLength(1);
    expect((await ds.query(`SELECT 1 FROM bets WHERE user_id = $1`, [p.userId])).length).toBe(1);

    const poor = await platformUser('sora', 500);
    expect(await bet(poor.userId, 1_000)).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    const excluded = await platformUser('kaito', 50_000);
    core.blocked.add(excluded.externalId);
    expect(await bet(excluded.userId, 1_000)).toEqual({ ok: false, reason: 'RESPONSIBLE_GAMING_BLOCKED' });
    expect((await ds.query(`SELECT 1 FROM bets WHERE user_id = ANY($1::uuid[])`, [[poor.userId, excluded.userId]])).length).toBe(0);
  });

  it('keeps the decision when Core is down and settles exactly once when it is back', async () => {
    const p = await platformUser('mei', 10_000);
    await bet(p.userId, 2_000);
    const [row] = await ds.query(`SELECT id FROM bets WHERE user_id = $1`, [p.userId]);

    core.down = true;
    const before = core.settles;
    expect(await cashout(row.id, p.userId, 2_000, 3_000)).toBeNull(); // decision committed, money pending
    expect((await ds.query(`SELECT status FROM bets WHERE id = $1`, [row.id]))[0].status).toBe('CASHED_OUT');
    expect((await ds.query(`SELECT status, attempts FROM platform_settlements WHERE bet_id = $1`, [row.id]))[0]).toMatchObject({ status: 'PENDING', attempts: 1 });

    core.down = false;
    await ds.query(`UPDATE platform_settlements SET next_attempt_at = now() WHERE bet_id = $1`, [row.id]);
    await Promise.all([ledger.tick(), ledger.tick(), ledger.tick()]); // concurrent workers
    await ledger.tick();
    expect(core.settles - before).toBe(1);
    expect(core.available(p.walletId)).toBe(11_000);
    expect(await ledger.pending()).toBe(0);
    expect(pushes.at(-1)).toEqual([p.userId, 11_000]);
  });

  it('a settle that Core applied but whose answer was lost is retried with the same key and applied once', async () => {
    const p = await platformUser('emi', 10_000);
    await bet(p.userId, 1_000);
    const [row] = await ds.query(`SELECT id, external_hold_id FROM bets WHERE user_id = $1`, [p.userId]);
    core.dropResponse.set(`POST /api/v1/holds/${row.external_hold_id}/settle`, 2); // lost on both attempts of the client: Ronin's own retry must replay the key
    const before = core.settles;
    await cashout(row.id, p.userId, 1_000, 2_000);
    expect(core.settles - before).toBe(1); // applied in Core
    expect((await ds.query(`SELECT status FROM platform_settlements WHERE bet_id = $1`, [row.id]))[0].status).toBe('PENDING'); // but Ronin never heard back
    await ds.query(`UPDATE platform_settlements SET next_attempt_at = now() WHERE bet_id = $1`, [row.id]);
    await ledger.tick(); // same key: Core replays its receipt
    expect(core.settles - before).toBe(1);
    expect(core.available(p.walletId)).toBe(11_000);
    expect(await ledger.pending()).toBe(0);
  });

  it('settles a mixed round: platform losses settled in Core with no payout, bot losses posted locally', async () => {
    const p = await platformUser('hana', 3_000);
    const bot = await local.createUser({ username: `bot_${round}`, isBot: true, grantCents: 10_000 });
    await bet(p.userId, 1_000);
    expect(await bet(bot.userId, 700)).toEqual({ ok: true, balance: 9_300 });
    const rows = await ds.query(`SELECT id, user_id, amount FROM bets WHERE round_id = $1`, [round]);

    await ledger.settleLosses(round, rows.map((r: { id: string; user_id: string; amount: string }) => ({ betId: r.id, userId: r.user_id, amount: Number(r.amount) })), `round-loss:${round}`, TOKEN);
    for (let i = 0; i < 100 && (await ledger.pending()) > 0; i++) await new Promise((r) => setTimeout(r, 20)); // the loss settlement runs in the background

    expect(core.available(p.walletId)).toBe(2_000);
    expect(core.held.get(p.walletId)).toBe(0);
    expect((await ds.query(`SELECT status FROM bets WHERE round_id = $1`, [round])).every((s: { status: string }) => s.status === 'LOST')).toBe(true);
    const audit = await local.audit();
    expect(audit.totalPostings).toBe(0);
    expect(audit.cacheMismatches).toEqual([]);
    expect(await ledger.pending()).toBe(0);
  });

  it('gives the stake back (void settlement) when the bet cannot be recorded', async () => {
    const p = await platformUser('yuki', 4_000);
    await expect(
      ledger.debitStake({ betId: crypto.randomUUID(), userId: p.userId, roundId: round, amount: 1_000, autoX100: null, clientKey: 'k', placedAt: Date.now(), idempotencyKey: `bet:${round}:${p.userId}`, fencingToken: 0 }),
    ).rejects.toThrow();
    expect(core.available(p.walletId)).toBe(4_000);
    expect(core.held.get(p.walletId)).toBe(0);
    expect(holdsOf(p.walletId).map((h) => h.status)).toEqual(['captured']); // captured and returned in one settle
  });

  it('no confirmed settlement window means no bet: a refused intention releases, an ambiguous one unwinds', async () => {
    const a = await platformUser('goro', 4_000);
    core.failNext.set('/settlement-intent', { status: 422, code: 'hold_expired' });
    expect(await bet(a.userId, 1_000)).toEqual({ ok: false, reason: 'WALLET_UNAVAILABLE' });
    expect(core.available(a.walletId)).toBe(4_000);
    expect(holdsOf(a.walletId).map((h) => h.status)).toEqual(['released']);

    // Intention registered in Core, answer lost: the bet is refused and the stake unwinds through
    // the idempotent replay (hold -> same intention -> void), never through a refused release.
    const b = await platformUser('rina', 4_000);
    core.dropResponse.set('/settlement-intent', 2); // the client's single retry is lost as well
    expect((await bet(b.userId, 1_000)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(core.available(b.walletId)).toBe(4_000);
    expect(core.held.get(b.walletId)).toBe(0);
    expect((await ds.query(`SELECT 1 FROM bets WHERE user_id = $1`, [b.userId])).length).toBe(0);
  });

  it('a settlement Core can never accept is parked as FAILED, not retried forever', async () => {
    const p = await platformUser('daichi', 5_000);
    await bet(p.userId, 1_000);
    const [row] = await ds.query(`SELECT id FROM bets WHERE user_id = $1`, [p.userId]);
    core.down = true;
    await cashout(row.id, p.userId, 1_000, 2_000);
    core.down = false;
    core.clockSkew = 3_600_000 + GRACE_MS + 1_000; // Core's expiry + grace passed while Ronin could not reach it
    const failedBefore = ledger.failed;
    await ds.query(`UPDATE platform_settlements SET next_attempt_at = now() WHERE bet_id = $1`, [row.id]);
    await ledger.tick();
    core.clockSkew = 0;
    const [s] = await ds.query(`SELECT status, attempts, last_error FROM platform_settlements WHERE bet_id = $1`, [row.id]);
    expect(s.status).toBe('FAILED');
    expect(s.last_error).toMatch(/settlement_grace_expired/);
    expect(ledger.failed).toBe(failedBefore + 1);
    await ds.query(`UPDATE platform_settlements SET next_attempt_at = now() WHERE bet_id = $1`, [row.id]);
    expect(await ledger.tick()).toBe(0); // not selected again
    expect(await ledger.pending()).toBe(0);
  });

  it('registers a missing intention and settles in the same pass', async () => {
    const p = await platformUser('jiro', 5_000);
    await bet(p.userId, 1_000);
    const [row] = await ds.query(`SELECT id, external_hold_id FROM bets WHERE user_id = $1`, [p.userId]);
    core.holds.get(row.external_hold_id)!.intent = undefined; // as if the registration had never reached Core
    core.replies.delete(`ronin:intent:${row.id}`);
    expect(await cashout(row.id, p.userId, 1_000, 1_500)).toBe(5_500);
  });

  it('renews a revoked machine token once and repeats the call with the same idempotency key', async () => {
    const p = await platformUser('riku', 3_000);
    const grantsBefore = core.tokenGrants;
    core.token = `svc-token-rotated-${round}`; // Core revokes the cached token
    expect(await bet(p.userId, 1_000)).toEqual({ ok: true, balance: 2_000 });
    expect(core.tokenGrants).toBe(grantsBefore + 1); // exactly one forced renewal
    expect(holdsOf(p.walletId)).toHaveLength(1);
  });
});
