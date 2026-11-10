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

const HOUSE = '00000000-0000-4000-8000-0000000000aa';

/**
 * A small stand-in for platform-core that follows its wallet contract: client-credentials
 * tokens, accounts with balances, stake holds that enforce funds and responsible-gaming
 * blocks, capture into the house with a payout, release, and idempotency-key replay.
 */
class FakeCore {
  balances = new Map<string, number>(); // accountId -> minor units
  owner = new Map<string, string>(); // accountId -> userId
  blocked = new Set<string>(); // userIds refused by responsible gaming
  holds = new Map<string, { accountId: string; amount: number; status: string }>();
  replies = new Map<string, unknown>(); // idempotency key -> original response
  captures = 0;
  down = false;
  server!: Server;

  addUser(userId: string, accountId: string, balance: number): void {
    this.balances.set(accountId, balance);
    this.owner.set(accountId, userId);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (this.down) return send(503, { code: 'unavailable', message: 'down', correlationId: 'x' });
        const url = new URL(req.url!, 'http://core');
        if (url.pathname === '/oauth/token') return send(200, { access_token: 'svc-token', token_type: 'Bearer', expires_in: 600 });
        if (req.headers.authorization !== 'Bearer svc-token') return send(401, { code: 'invalid_token', message: '', correlationId: 'x' });
        if (req.method === 'GET' && url.pathname === '/v1/wallet/accounts') {
          const userId = url.searchParams.get('userId');
          const list = [...this.owner].filter(([, u]) => u === userId).map(([id]) => ({ id, kind: 'user_cash', currency: 'EUR', balance: String(this.balances.get(id)) }));
          return send(200, list);
        }
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!key) return send(400, { code: 'idempotency_key_required', message: '', correlationId: 'x' });
        if (this.replies.has(key)) return send(200, this.replies.get(key));
        const body = raw ? JSON.parse(raw) : {};
        const reply = (status: number, b: unknown) => {
          if (status < 300) this.replies.set(key, b);
          send(status, b);
        };
        if (req.method === 'POST' && url.pathname === '/v1/wallet/holds') {
          const user = this.owner.get(body.accountId)!;
          if (this.blocked.has(user)) return reply(403, { code: 'self_excluded', message: 'blocked', correlationId: 'x' });
          const amount = Number(body.amount);
          if (this.balances.get(body.accountId)! < amount) return reply(422, { code: 'insufficient_funds', message: '', correlationId: 'x' });
          this.balances.set(body.accountId, this.balances.get(body.accountId)! - amount);
          const id = crypto.randomUUID();
          this.holds.set(id, { accountId: body.accountId, amount, status: 'active' });
          return reply(201, { id, status: 'active', amount: body.amount });
        }
        const m = /^\/v1\/wallet\/holds\/([^/]+)\/(capture|release)$/.exec(url.pathname);
        if (req.method === 'POST' && m) {
          const hold = this.holds.get(m[1]!);
          if (!hold) return reply(404, { code: 'hold_not_found', message: '', correlationId: 'x' });
          if (hold.status !== 'active') return reply(409, { code: 'hold_resolved', message: '', correlationId: 'x' });
          if (m[2] === 'capture') {
            if (body.toAccountId !== HOUSE) return reply(422, { code: 'invalid_capture', message: '', correlationId: 'x' });
            this.captures++;
            hold.status = 'captured';
            this.balances.set(hold.accountId, this.balances.get(hold.accountId)! + Number(body.payoutAmount));
          } else {
            hold.status = 'released';
            this.balances.set(hold.accountId, this.balances.get(hold.accountId)! + hold.amount);
          }
          return reply(200, { id: m[1], status: hold.status, transactionId: crypto.randomUUID() });
        }
        send(404, { code: 'not_found', message: '', correlationId: 'x' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('PlatformLedger (real PostgreSQL + fake platform-core)', () => {
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
    const client = new CoreClient({ baseUrl: url, clientId: 'ronin-rush', clientSecret: 's', currency: 'EUR', retries: 1, sleep: async () => {} });
    ledger = new PlatformLedger(ds, local, client, { houseAccountId: HOUSE });
    ledger.onBalance = (u, b) => pushes.push([u, b]);
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

  async function platformUser(name: string, balance: number) {
    const externalId = crypto.randomUUID();
    const u = await local.createUser({ username: name, externalId, grantCents: 0 });
    const accountId = crypto.randomUUID();
    core.addUser(externalId, accountId, balance);
    return { ...u, externalId, accountId };
  }

  const bet = (userId: string, amount: number, betId = crypto.randomUUID()) =>
    ledger.debitStake({ betId, userId, roundId: round, amount, autoX100: null, clientKey: betId, placedAt: 1, idempotencyKey: `bet:${round}:${userId}`, fencingToken: TOKEN });

  it('reserves the stake in Core, records the bet locally without postings, and pays the cash-out in Core', async () => {
    const p = await platformUser('aiko', 10_000);
    const postingsBefore = (await local.audit()).postings;

    expect(await bet(p.userId, 1_000)).toEqual({ ok: true, balance: 9_000 });
    const [row] = await ds.query(`SELECT id, external_hold_id FROM bets WHERE user_id = $1`, [p.userId]);
    expect(row.external_hold_id).toBeTruthy();
    expect((await local.audit()).postings).toBe(postingsBefore); // money did not move locally

    const balance = await ledger.creditCashout({ betId: row.id, userId: p.userId, roundId: round, stake: 1_000, payout: 2_500, x100: 250, auto: false, cashedAt: 2, idempotencyKey: `cashout:${row.id}`, fencingToken: TOKEN });
    expect(balance).toBe(11_500);
    expect(core.balances.get(p.accountId)).toBe(11_500);
    const [s] = await ds.query(`SELECT status, payout FROM platform_settlements WHERE bet_id = $1`, [row.id]);
    expect(s).toEqual({ status: 'DONE', payout: '2500' });
    const [b] = await ds.query(`SELECT status, payout FROM bets WHERE id = $1`, [row.id]);
    expect(b).toEqual({ status: 'CASHED_OUT', payout: '2500' });
  });

  it('a retried bet creates one hold; Core refusals map to game errors and record nothing', async () => {
    const p = await platformUser('ren', 5_000);
    const betId = crypto.randomUUID();
    await bet(p.userId, 1_000, betId);
    await bet(p.userId, 1_000, betId); // same idempotency key: replayed by Core and by the local ledger
    expect(core.balances.get(p.accountId)).toBe(4_000);
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
    const capturesBefore = core.captures;
    const balance = await ledger.creditCashout({ betId: row.id, userId: p.userId, roundId: round, stake: 2_000, payout: 3_000, x100: 150, auto: true, cashedAt: 2, idempotencyKey: `cashout:${row.id}`, fencingToken: TOKEN });
    expect(balance).toBeNull(); // decision committed, money pending
    const [b] = await ds.query(`SELECT status FROM bets WHERE id = $1`, [row.id]);
    expect(b.status).toBe('CASHED_OUT');
    expect((await ds.query(`SELECT status, attempts FROM platform_settlements WHERE bet_id = $1`, [row.id]))[0]).toMatchObject({ status: 'PENDING', attempts: 1 });

    core.down = false;
    await ds.query(`UPDATE platform_settlements SET next_attempt_at = now() WHERE bet_id = $1`, [row.id]);
    await Promise.all([ledger.tick(), ledger.tick(), ledger.tick()]); // concurrent workers
    await ledger.tick();
    expect(core.captures - capturesBefore).toBe(1);
    expect(core.balances.get(p.accountId)).toBe(11_000);
    expect(await ledger.pending()).toBe(0);
    expect(pushes.at(-1)).toEqual([p.userId, 11_000]);
  });

  it('settles a mixed round: platform losses captured in Core with no payout, bot losses posted locally', async () => {
    const p = await platformUser('hana', 3_000);
    const bot = await local.createUser({ username: `bot_${round}`, isBot: true, grantCents: 10_000 });
    await bet(p.userId, 1_000);
    expect(await bet(bot.userId, 700)).toEqual({ ok: true, balance: 9_300 });
    const rows = await ds.query(`SELECT id, user_id, amount FROM bets WHERE round_id = $1`, [round]);

    await ledger.settleLosses(round, rows.map((r: { id: string; user_id: string; amount: string }) => ({ betId: r.id, userId: r.user_id, amount: Number(r.amount) })), `round-loss:${round}`, TOKEN);
    await ledger.tick();

    expect(core.balances.get(p.accountId)).toBe(2_000);
    const statuses = await ds.query(`SELECT status FROM bets WHERE round_id = $1`, [round]);
    expect(statuses.every((s: { status: string }) => s.status === 'LOST')).toBe(true);
    const audit = await local.audit();
    expect(audit.totalPostings).toBe(0);
    expect(audit.cacheMismatches).toEqual([]);
    expect(await ledger.pending()).toBe(0);
  });

  it('releases the hold when the bet cannot be recorded (fenced out)', async () => {
    const p = await platformUser('yuki', 4_000);
    await expect(
      ledger.debitStake({ betId: crypto.randomUUID(), userId: p.userId, roundId: round, amount: 1_000, autoX100: null, clientKey: 'k', placedAt: 1, idempotencyKey: `bet:${round}:${p.userId}`, fencingToken: 0 }),
    ).rejects.toThrow();
    expect(core.balances.get(p.accountId)).toBe(4_000);
    expect([...core.holds.values()].filter((h) => h.accountId === p.accountId).map((h) => h.status)).toEqual(['released']);
  });
});
