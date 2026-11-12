import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SOCKET_EVENTS, type RoundEvent } from '@ronin/shared';
import Redis from 'ioredis';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Failure and idempotency scenarios against a REAL platform-core (not a stand-in): a Core API
 * process built from source (tag v0.2.0, @danigil/platform-contracts 0.3.0), a fault-injecting HTTP
 * proxy between Ronin and Core, and a Ronin API process in PLATFORM_MODE. Ronin uses only the
 * /api/v1 wallet: player-session activation, createHold, settlement intention, settle.
 *
 * Opt-in (not in CI: Core's image is private). Needs a Core database migrated and provisioned with
 * Core's own scripts (`db:migrate`, `db:seed`, `db:seed:services`, so the `ronin` client has its
 * documented scopes and system grants), and:
 *   CORE_E2E_DIR          platform-core checkout, built (dist/apps/api/src/main.js)
 *   CORE_E2E_ENV          file of `export KEY=VALUE` lines for Core (PORT, DATABASE_URL, JWT_*, ...)
 *   CORE_E2E_SECRET       the `ronin` client secret from SERVICE_CLIENT_SECRETS_FILE
 *   TEST_DATABASE_URL, REDIS_URL, and a built Ronin API (pnpm build)
 * Test players get kyc_status = 'verified' directly in Core's database (Core's KYC needs document
 * uploads to object storage). Wallet grants are never inserted: Core creates them when the player's
 * own session token activates Ronin.
 */
const DIST = join(__dirname, '..', 'dist', 'main.js');
const CORE_DIR = process.env.CORE_E2E_DIR;
const CORE_ENV_FILE = process.env.CORE_E2E_ENV;
const CORE_SECRET = process.env.CORE_E2E_SECRET;
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_BASE = process.env.REDIS_URL;
const enabled = Boolean(CORE_DIR && CORE_ENV_FILE && CORE_SECRET && DB_URL && REDIS_BASE && existsSync(DIST));
const RONIN_PORT = 3231;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?(.*)$/.exec(line.trim());
    if (!m || !m[1] || m[1].startsWith('#')) continue;
    for (const part of m[1].split(/\s+(?=[A-Z_][A-Z0-9_]*=)/)) {
      const eq = part.indexOf('=');
      if (eq > 0) env[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return env;
}

/** HTTP proxy in front of Core that can drop Core's answer after Core has processed the request. */
class FaultProxy {
  server!: Server;
  /** Each rule drops the response of the next matching request (Core still executes it). */
  private dropRules: Array<{ method: string; path: RegExp }> = [];
  dropped: string[] = [];
  constructor(private readonly target: string) {}

  dropNextResponse(method: string, path: RegExp): void {
    this.dropRules.push({ method, path });
  }

  async start(): Promise<string> {
    const target = new URL(this.target);
    this.server = createServer((req, res) => {
      const rule = this.dropRules.findIndex((r) => r.method === req.method && r.path.test(req.url ?? ''));
      const drop = rule >= 0 ? this.dropRules.splice(rule, 1)[0] : null;
      const up = httpRequest(
        { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } },
        (upRes) => {
          if (drop) {
            upRes.resume();
            upRes.on('end', () => {
              this.dropped.push(`${req.method} ${req.url}`);
              res.socket?.destroy(); // Core committed; the caller never hears back
            });
            return;
          }
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', () => res.socket?.destroy()); // Core down: the caller sees a reset
      req.pipe(up);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

interface Player {
  userId: string;
  email: string;
  token: string;
  accountId: string;
  stamp: string;
}

describe.skipIf(!enabled)('Ronin against a real platform-core v0.2.0 (/api/v1): failures and idempotency', () => {
  const coreEnv = enabled ? readEnvFile(CORE_ENV_FILE!) : {};
  const coreUrl = `http://127.0.0.1:${coreEnv.PORT ?? '3601'}`;
  let core: ChildProcess | null = null;
  let coreLog = '';
  let ronin: ChildProcess;
  let roninLog = '';
  let proxy: FaultProxy;
  let coreDb: Client;
  let roninDb: Client;
  let roninDbUrl: string;
  const sockets: Socket[] = [];
  const events: RoundEvent[] = [];

  async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 30_000, what = 'condition'): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v as T;
      await sleep(50);
    }
    throw new Error(`timeout waiting for ${what}\n--- ronin ---\n${roninLog.slice(-3000)}\n--- core ---\n${coreLog.slice(-1500)}`);
  }

  async function startCore(): Promise<void> {
    coreLog = '';
    core = spawn(process.execPath, [join(CORE_DIR!, 'dist/apps/api/src/main.js')], { cwd: CORE_DIR, env: { ...process.env, ...coreEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    core.stdout!.on('data', (d) => (coreLog += d.toString()));
    core.stderr!.on('data', (d) => (coreLog += d.toString()));
    await until(async () => (await fetch(`${coreUrl}/health/ready`).catch(() => null))?.ok, 30_000, 'core ready');
  }

  async function stopCore(): Promise<void> {
    const p = core;
    core = null;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill('SIGKILL'); // a crash, not a graceful shutdown
    });
  }

  const coreJson = async (path: string, init: { method?: string; token?: string; body?: unknown; key?: string } = {}) => {
    const res = await fetch(`${coreUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.key ? { 'idempotency-key': init.key } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  };

  /** A Core player: registered, KYC verified (fixture), 100.00 EUR deposited. */
  async function newPlayer(name: string): Promise<Player> {
    const stamp = `${name}-${Date.now()}`;
    const email = `${stamp}@example.com`;
    const password = 'a-long-test-password-1';
    const reg = await coreJson('/v1/auth/register', { method: 'POST', key: `reg-${stamp}`, body: { email, password, displayName: name } });
    expect(reg.status).toBeLessThan(300);
    const userId = String(reg.body.id);
    await coreDb.query(`UPDATE users SET kyc_status = 'verified' WHERE id = $1`, [userId]);
    const login = await coreJson('/v1/auth/login', { method: 'POST', body: { email, password } });
    const token = String(login.body.accessToken);
    const dep = await coreJson('/v1/testing/deposit', { method: 'POST', token, key: `dep-${stamp}`, body: { amount: '10000', currency: 'EUR' } });
    expect(dep.status, JSON.stringify(dep.body)).toBeLessThan(300);
    const [acc] = (await coreDb.query(`SELECT id FROM accounts WHERE user_id = $1 AND kind = 'user_cash' AND currency = 'EUR'`, [userId])).rows;
    return { userId, email, token, accountId: acc.id, stamp };
  }

  const coreBalance = async (accountId: string) =>
    Number((await coreDb.query(`SELECT COALESCE(SUM(amount), 0)::bigint AS b FROM ledger_entries WHERE account_id = $1`, [accountId])).rows[0].b);
  const coreHolds = async (accountId: string) =>
    (await coreDb.query(`SELECT id, status, amount::bigint AS amount, reference FROM holds WHERE account_id = $1 ORDER BY created_at`, [accountId])).rows as Array<{
      id: string;
      status: string;
      amount: string;
      reference: string;
    }>;

  async function connect(p: Player): Promise<Socket> {
    const s = io(`http://127.0.0.1:${RONIN_PORT}`, { transports: ['websocket'], auth: { token: p.token } });
    sockets.push(s);
    await new Promise((r) => s.once(SOCKET_EVENTS.hello, r));
    return s;
  }
  const emitAck = <T>(s: Socket, event: string, payload: unknown) =>
    new Promise<T>((resolve) => s.timeout(15_000).emit(event, payload, (err: unknown, res: T) => resolve(err ? ({ ok: false, error: 'TIMEOUT' } as T) : res)));
  const nextBetting = async () => {
    const from = events.length;
    const e = await until(() => events.slice(from).find((x) => x.type === 'round.betting'), 30_000, 'betting window');
    return (e as Extract<RoundEvent, { type: 'round.betting' }>).roundId;
  };
  const settledRound = (roundId: number) =>
    until(() => events.find((e): e is Extract<RoundEvent, { type: 'round.settled' }> => e.type === 'round.settled' && e.roundId === roundId), 60_000, `round ${roundId} settled`);
  const settlement = async (betId: string) =>
    (await roninDb.query(`SELECT status, attempts, payout::bigint AS payout FROM platform_settlements WHERE bet_id = $1`, [betId])).rows[0] as
      | { status: string; attempts: number; payout: string }
      | undefined;
  const ronintBet = async (betId: string) =>
    (await roninDb.query(`SELECT status, cashout_x100, payout::bigint AS payout FROM bets WHERE id = $1`, [betId])).rows[0] as { status: string; cashout_x100: number | null; payout: string };

  beforeAll(async () => {
    coreDb = new Client({ connectionString: coreEnv.DATABASE_URL });
    await coreDb.connect();
    await startCore();
    proxy = new FaultProxy(coreUrl);
    const proxyUrl = await proxy.start();

    const admin = new Client({ connectionString: DB_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ronin_e2e_core WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ronin_e2e_core`);
    await admin.end();
    roninDbUrl = DB_URL!.replace(/\/[^/]+$/, '/ronin_e2e_core');
    const redisUrl = REDIS_BASE!.replace(/\/\d*$/, '') + '/5';
    const r = new Redis(redisUrl);
    await r.flushdb();
    r.disconnect();

    ronin = spawn(process.execPath, [DIST], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INSTANCE_ID: 'e2e-core',
        PORT: String(RONIN_PORT),
        DATABASE_URL: roninDbUrl,
        REDIS_URL: redisUrl,
        REDIS_NAMESPACE: 'ronin-e2e-core',
        PLATFORM_MODE: 'true',
        SERVICE_NAME: 'ronin-rush',
        CORE_URL: proxyUrl,
        CORE_JWKS_URL: `${proxyUrl}/.well-known/jwks.json`,
        CORE_ISSUER: coreEnv.JWT_ISSUER ?? coreUrl,
        CORE_AUDIENCE: coreEnv.JWT_AUDIENCE ?? 'platform-core',
        CORE_CLIENT_ID: 'ronin',
        CORE_CLIENT_SECRET: CORE_SECRET,
        CORE_SERVICE_ID: 'ronin',
        CORE_CURRENCY: 'EUR',
        BETTING_MS: '1500',
        RESULT_MS: '600',
        GROWTH_K: '0.0005',
        CHAIN_LENGTH: '500',
        CHAIN_TERMINAL_SEED: 'd4'.repeat(32),
        BOTS_COUNT: '0',
        KAFKA_BROKERS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ronin.stdout!.on('data', (d) => (roninLog += d.toString()));
    ronin.stderr!.on('data', (d) => (roninLog += d.toString()));
    await until(async () => (await fetch(`http://127.0.0.1:${RONIN_PORT}/health`).catch(() => null))?.ok, 60_000, 'ronin up');
    roninDb = new Client({ connectionString: roninDbUrl });
    await roninDb.connect();
    // Every socket event goes to one log, whoever receives it.
    const watcher = io(`http://127.0.0.1:${RONIN_PORT}`, { transports: ['websocket'] });
    sockets.push(watcher);
    watcher.on(SOCKET_EVENTS.roundEvent, (e: RoundEvent) => events.push(e));
    watcher.on(SOCKET_EVENTS.roundBatch, (es: RoundEvent[]) => events.push(...es));
  }, 120_000);

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    ronin?.kill('SIGTERM');
    await stopCore();
    proxy?.server.close();
    await roninDb?.end().catch(() => undefined);
    await coreDb?.end().catch(() => undefined);
  });

  const machineToken = async () => {
    const res = await fetch(`${coreUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`ronin:${CORE_SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'wallet:read wallet:write' }),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  };
  const holdRow = async (accountId: string) =>
    (await coreDb.query(`SELECT h.id, h.status, h.reference, h.intent_id FROM holds h WHERE h.account_id = $1 ORDER BY h.created_at`, [accountId])).rows as Array<{ id: string; status: string; reference: string; intent_id: string | null }>;

  it('first entry: the player\'s own session creates one grant for Ronin on their wallet, and no other', async () => {
    const p = await newPlayer('aiko');
    await connect(p);
    const grants = (await coreDb.query(`SELECT client_id, account_id, can_write FROM service_wallet_grants WHERE account_id = $1`, [p.accountId])).rows;
    expect(grants).toEqual([{ client_id: 'ronin', account_id: p.accountId, can_write: true }]);
    const [u] = (await roninDb.query(`SELECT external_wallet_id FROM users WHERE external_id = $1`, [p.userId])).rows;
    expect(u.external_wallet_id).toBe(p.accountId);
    // Ronin holds no grant on anybody who never entered it.
    const stranger = await newPlayer('ghost');
    const token = await machineToken();
    const probe = await coreJson(`/api/v1/wallets/${stranger.accountId}/balance`, { token });
    expect(probe.status).toBeGreaterThanOrEqual(403);
    expect(probe.status).toBeLessThan(500);
  }, 60_000);

  it('a whole round: stake held in Core, window confirmed before the bet, settled by one atomic settle', async () => {
    const p = await newPlayer('mika');
    const s = await connect(p);
    const roundId = await nextBetting();
    const bet = await emitAck<{ ok: boolean; bet: { betId: string } }>(s, SOCKET_EVENTS.placeBet, { amount: 1_000, autoX100: 110, idempotencyKey: 'core-mika-bet-0001' });
    expect(bet.ok, JSON.stringify(bet)).toBe(true);
    expect(await coreBalance(p.accountId)).toBe(9_000); // the stake sits in Core's escrow
    const [h0] = await holdRow(p.accountId);
    expect(h0).toMatchObject({ status: 'active', reference: `ronin:${roundId}:${bet.bet.betId}` });
    expect(h0!.intent_id).toBeTruthy(); // settlement window confirmed before the bet was accepted
    const crash = (await settledRound(roundId)).crashX100;
    const done = await until(async () => (await settlement(bet.bet.betId))?.status === 'DONE' && settlement(bet.bet.betId), 20_000, 'settlement');
    const payout = crash >= 110 ? 1_100 : 0;
    expect(Number(done.payout)).toBe(payout);
    expect(await coreBalance(p.accountId)).toBe(9_000 + payout);
    expect((await holdRow(p.accountId)).map((h) => h.status)).toEqual(['captured']);
  }, 90_000);

  it('Core down mid-round: the game decision stands, settlement is retried and lands exactly once; new bets are refused meanwhile', async () => {
    const p = await newPlayer('mei');
    const s = await connect(p);
    const roundId = await nextBetting();
    const bet = await emitAck<{ ok: boolean; bet: { betId: string } }>(s, SOCKET_EVENTS.placeBet, { amount: 2_000, autoX100: 110, idempotencyKey: 'core-mei-bet-00001' });
    expect(bet.ok, JSON.stringify(bet)).toBe(true);
    await until(() => events.some((e) => e.type === 'round.started' && e.roundId === roundId), 10_000, 'round start');
    await stopCore(); // Core crashes while the round runs

    const crash = (await settledRound(roundId)).crashX100;
    const decided = await ronintBet(bet.bet.betId);
    expect(decided.status).toBe(crash >= 110 ? 'CASHED_OUT' : 'LOST'); // the round ended normally
    const pending = await until(async () => {
      const st = await settlement(bet.bet.betId);
      return st && st.status === 'PENDING' && st.attempts >= 1 && st;
    }, 20_000, 'a failed settlement attempt');
    expect(pending.status).toBe('PENDING');
    expect((await fetch(`http://127.0.0.1:${RONIN_PORT}/health/ready`)).status).toBe(200); // Core is a soft dependency

    await nextBetting();
    const refused = await emitAck<{ ok: boolean; error?: string }>(s, SOCKET_EVENTS.placeBet, { amount: 500, autoX100: null, idempotencyKey: 'core-mei-bet-00002' });
    expect(refused).toEqual({ ok: false, error: 'WALLET_UNAVAILABLE' }); // no wallet, no bet

    await startCore();
    await until(async () => (await settlement(bet.bet.betId))?.status === 'DONE', 60_000, 'settlement after Core is back');
    const payout = crash >= 110 ? 2_200 : 0;
    expect(await coreBalance(p.accountId)).toBe(8_000 + payout); // the refused attempt, if it left a trace, is net zero
    // The bet's own hold was settled exactly once. A bet refused while Core was down may have left a
    // hold of its own: the unwinding replays it, registers its intention and settles it `void`.
    const holds = await holdRow(p.accountId);
    expect(holds.filter((h) => h.reference === `ronin:${roundId}:${bet.bet.betId}`).map((h) => h.status)).toEqual(['captured']);
    expect(holds.filter((h) => h.status !== 'captured')).toEqual([]);
    expect((await coreDb.query(`SELECT COUNT(*)::int AS n FROM ledger_transactions lt JOIN holds h ON h.transaction_id = lt.id WHERE h.account_id = $1`, [p.accountId])).rows[0].n).toBe(holds.length);
  }, 150_000);

  it('lost responses: hold, intention and settle are each retried with the same key and applied once (including a settle whose answer is lost on every attempt)', async () => {
    const p = await newPlayer('ren');
    const s = await connect(p);
    const roundId = await nextBetting();
    proxy.dropNextResponse('POST', /^\/api\/v1\/wallets\/[^/]+\/holds$/);
    proxy.dropNextResponse('POST', /^\/api\/v1\/holds\/[^/]+\/settlement-intent$/);
    for (let i = 0; i < 4; i++) proxy.dropNextResponse('POST', /^\/api\/v1\/holds\/[^/]+\/settle$/); // applied once, answer lost on every attempt of the client
    const bet = await emitAck<{ ok: boolean; bet: { betId: string } }>(s, SOCKET_EVENTS.placeBet, { amount: 1_500, autoX100: 110, idempotencyKey: 'core-ren-bet-00001' });
    expect(bet.ok, JSON.stringify(bet)).toBe(true);
    expect(proxy.dropped.some((d) => /\/holds$/.test(d))).toBe(true);
    expect(proxy.dropped.some((d) => /settlement-intent$/.test(d))).toBe(true);
    expect(await holdRow(p.accountId)).toHaveLength(1); // the retries replayed, they did not hold twice
    expect((await coreDb.query(`SELECT COUNT(*)::int AS n FROM settlement_intents WHERE id = $1`, [(await holdRow(p.accountId))[0]!.intent_id])).rows[0].n).toBe(1);

    const crash = (await settledRound(roundId)).crashX100;
    await until(async () => (await settlement(bet.bet.betId))?.status === 'DONE', 30_000, 'settlement');
    expect(proxy.dropped.some((d) => /\/settle$/.test(d))).toBe(true);
    const payout = crash >= 110 ? 1_650 : 0;
    expect(await coreBalance(p.accountId)).toBe(8_500 + payout); // payout credited once
    expect((await holdRow(p.accountId)).map((h) => h.status)).toEqual(['captured']);
  }, 90_000);

  it('idempotency at Core: replaying the settle key returns the receipt without a second posting; another body or a release is refused', async () => {
    const p = await newPlayer('sora');
    const s = await connect(p);
    const roundId = await nextBetting();
    const bet = await emitAck<{ ok: boolean; bet: { betId: string } }>(s, SOCKET_EVENTS.placeBet, { amount: 1_000, autoX100: 101, idempotencyKey: 'core-sora-bet-0001' });
    expect(bet.ok).toBe(true);
    await settledRound(roundId);
    await until(async () => (await settlement(bet.bet.betId))?.status === 'DONE', 30_000, 'settlement');
    const after = await coreBalance(p.accountId);
    const [hold] = await holdRow(p.accountId);
    const payout = (await ronintBet(bet.bet.betId)).payout;
    const token = await machineToken();
    const same = await coreJson(`/api/v1/holds/${hold!.id}/settle`, {
      method: 'POST', token, key: `ronin:settle:${bet.bet.betId}`,
      body: { result: Number(payout) > 0 ? 'cash-out' : 'loss', payoutAmount: String(payout), commissionAmount: '0', asset: 'EUR' },
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body).toMatchObject({ status: 'settled', settlementId: `ronin:bet:${bet.bet.betId}`, payoutAmount: String(payout) });
    const other = await coreJson(`/api/v1/holds/${hold!.id}/settle`, {
      method: 'POST', token, key: `ronin:settle:${bet.bet.betId}`,
      body: { result: 'cash-out', payoutAmount: '999999', commissionAmount: '0', asset: 'EUR' },
    });
    expect(other.body).toMatchObject({ code: 'idempotency_conflict' });
    const newKey = await coreJson(`/api/v1/holds/${hold!.id}/settle`, {
      method: 'POST', token, key: `attacker-second-settle-${p.stamp}`,
      body: { result: 'cash-out', payoutAmount: '999999', commissionAmount: '0', asset: 'EUR' },
    });
    expect(newKey.status).toBeGreaterThanOrEqual(400);
    expect(await coreBalance(p.accountId)).toBe(after); // nothing moved
    expect(await coreBalance(p.accountId)).toBe(9_000 + Number(payout));
  }, 90_000);

  it('self-exclusion mid-session: the next bet is refused and nothing is held; the accepted bet still settles', async () => {
    const p = await newPlayer('kaito');
    const s = await connect(p);
    const first = await nextBetting();
    const ok = await emitAck<{ ok: boolean; bet: { betId: string } }>(s, SOCKET_EVENTS.placeBet, { amount: 1_000, autoX100: null, idempotencyKey: 'core-kaito-bet-001' });
    expect(ok.ok).toBe(true);

    const excl = await coreJson('/v1/responsible-gaming/restrictions', { method: 'POST', token: p.token, key: `excl-${p.stamp}`, body: { kind: 'self_exclusion', days: 30 } });
    expect(excl.status, JSON.stringify(excl.body)).toBeLessThan(300);

    await settledRound(first);
    await until(async () => (await settlement(ok.bet.betId))?.status === 'DONE', 20_000, 'first bet settlement'); // accepted intention settles despite the exclusion
    await nextBetting();
    const refused = await emitAck<{ ok: boolean; error?: string }>(s, SOCKET_EVENTS.placeBet, { amount: 1_000, autoX100: null, idempotencyKey: 'core-kaito-bet-002' });
    expect(refused).toEqual({ ok: false, error: 'RESPONSIBLE_GAMING_BLOCKED' });
    expect(await holdRow(p.accountId)).toHaveLength(1); // only the first round's hold
    expect(await coreBalance(p.accountId)).toBe(9_000);
  }, 120_000);

  it('an insufficient balance is refused by Core and nothing is recorded', async () => {
    const p = await newPlayer('poor');
    const s = await connect(p);
    await nextBetting();
    const refused = await emitAck<{ ok: boolean; error?: string }>(s, SOCKET_EVENTS.placeBet, { amount: 10_001, autoX100: null, idempotencyKey: 'core-poor-bet-0001' });
    expect(refused).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    expect(await holdRow(p.accountId)).toHaveLength(0);
  }, 60_000);

  it('a settlement that arrives after the 1800 s grace is refused for good: parked as FAILED, the stake refunded by Core', async () => {
    const p = await newPlayer('late');
    const s = await connect(p);
    const roundId = await nextBetting();
    const bet = await emitAck<{ ok: boolean; bet: { betId: string } }>(s, SOCKET_EVENTS.placeBet, { amount: 1_000, autoX100: 110, idempotencyKey: 'core-late-bet-0001' });
    expect(bet.ok).toBe(true);
    await until(() => events.some((e) => e.type === 'round.started' && e.roundId === roundId), 10_000, 'round start');
    await stopCore(); // Ronin cannot reach Core while the round ends
    await settledRound(roundId);
    await until(async () => (await settlement(bet.bet.betId))?.status === 'PENDING', 20_000, 'pending settlement');
    // Time passes in Core: expiry and the fixed grace are long gone (the clock cannot be sped up here).
    // The intention is immutable by design (trigger), so the fixture shifts the whole record three
    // hours into the past in one transaction with triggers off, in the local test database only.
    await coreDb.query('BEGIN');
    await coreDb.query(`SET LOCAL session_replication_role = replica`);
    await coreDb.query(`UPDATE settlement_intents SET registered_at = registered_at - interval '3 hours', settle_before = settle_before - interval '3 hours' WHERE id IN (SELECT intent_id FROM holds WHERE account_id = $1)`, [p.accountId]);
    await coreDb.query(`UPDATE holds SET expires_at = expires_at - interval '3 hours' WHERE account_id = $1`, [p.accountId]);
    await coreDb.query('COMMIT');
    await startCore();
    await until(async () => (await settlement(bet.bet.betId))?.status === 'FAILED', 90_000, 'FAILED settlement');
    const st = (await roninDb.query(`SELECT last_error FROM platform_settlements WHERE bet_id = $1`, [bet.bet.betId])).rows[0];
    expect(st.last_error).toMatch(/settlement_grace_expired|hold_expired|invalid_hold_state/);
    expect(await coreBalance(p.accountId)).toBe(10_000); // Core returned the stake
    // The parked row is visible to operators: health degrades (still ready) and names the cause.
    const health = await until(async () => {
      const h = (await fetch(`http://127.0.0.1:${RONIN_PORT}/health/ready`).then((r) => r.json())) as { status: string; ready: boolean; checks: { core: { ok: boolean; detail?: string } } };
      return h.status === 'degraded' && h;
    }, 20_000, 'degraded health');
    expect(health.ready).toBe(true);
    expect(health.checks.core.detail).toMatch(/refused by Core for good/);
  }, 180_000);
});
