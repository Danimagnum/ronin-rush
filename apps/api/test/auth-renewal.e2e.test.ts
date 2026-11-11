import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SOCKET_EVENTS, type RoundEvent, type ServerHello } from '@ronin/shared';
import Redis from 'ioredis';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Token expiry and renewal on a real API process, with 1-second tokens. The contract (0.2.0
 * docs/auth.md) forbids accepting a token past its exp; renewal must not cut the round. Uses
 * standalone HS256 tokens: the socket rules are the same for Core tokens in PLATFORM_MODE.
 */
const DIST = join(__dirname, '..', 'dist', 'main.js');
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_BASE = process.env.REDIS_URL;
const enabled = Boolean(DB_URL && REDIS_BASE && existsSync(DIST));
const PORT = 3211;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('token expiry and renewal on the socket (e2e)', () => {
  let proc: ChildProcess;
  let log = '';
  let sock: Socket;
  const events: RoundEvent[] = [];
  const expiredNotices: Array<{ expiresAt: number; at: number }> = [];
  const cashedAt = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const http = async (path: string, init?: { method?: string; body?: unknown; token?: string }): Promise<{ status: number; body: any }> => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init?.body ? JSON.stringify(init.body) : null,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v as T;
      await sleep(25);
    }
    throw new Error(`timeout\n${log.slice(-2000)}`);
  }
  const emitAck = <T>(event: string, payload: unknown) =>
    new Promise<T>((resolve) => sock.timeout(5_000).emit(event, payload, (err: unknown, res: T) => resolve(err ? ({ ok: false, error: 'TIMEOUT' } as T) : res)));
  const expOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp * 1000;
  const login = async (username: string) => (await http('/api/auth/login', { method: 'POST', body: { username, password: 'renewal-pass-1' } })).body.token as string;
  /** exp has 1 s granularity: retry until the token has at least 600 ms left. */
  async function freshLogin(username: string): Promise<string> {
    for (;;) {
      const t = await login(username);
      if (expOf(t) - Date.now() >= 600) return t;
      await sleep(expOf(t) - Date.now() + 20);
    }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: DB_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ronin_e2e_auth WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ronin_e2e_auth`);
    await admin.end();
    const redisUrl = REDIS_BASE!.replace(/\/\d*$/, '') + '/2';
    const r = new Redis(redisUrl);
    await r.flushdb();
    r.disconnect();
    proc = spawn(process.execPath, [DIST], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INSTANCE_ID: 'e2e-auth',
        PORT: String(PORT),
        DATABASE_URL: DB_URL!.replace(/\/[^/]+$/, '/ronin_e2e_auth'),
        REDIS_URL: redisUrl,
        REDIS_NAMESPACE: 'ronin-e2e-auth',
        JWT_TTL_SECONDS: '1',
        BETTING_MS: '1500',
        RESULT_MS: '600',
        GROWTH_K: '0.0005',
        CHAIN_LENGTH: '500',
        CHAIN_TERMINAL_SEED: 'c3'.repeat(32),
        BOTS_COUNT: '0',
        KAFKA_BROKERS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout!.on('data', (d) => (log += d.toString()));
    proc.stderr!.on('data', (d) => (log += d.toString()));
    await until(async () => (await http('/health').catch(() => null))?.body?.leader === true, 40_000);
    for (const u of ['renew_a', 'renew_b']) await http('/api/auth/register', { method: 'POST', body: { username: u, password: 'renewal-pass-1' } });
  }, 60_000);

  afterAll(async () => {
    sock?.disconnect();
    proc?.kill('SIGTERM');
    await sleep(300);
  });

  it('an anonymous socket signs in with auth:renew; hello and acks carry the token expiry', async () => {
    sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'] });
    const hello = await new Promise<ServerHello>((resolve) => sock.once(SOCKET_EVENTS.hello, resolve));
    expect(hello.session).toEqual({ platformMode: false, expiresAt: null });
    sock.on(SOCKET_EVENTS.roundEvent, (e: RoundEvent) => events.push(e));
    sock.on(SOCKET_EVENTS.roundBatch, (es: RoundEvent[]) => {
      events.push(...es);
      for (const e of es) if (e.type === 'bet.cashed_out') cashedAt.set(e.bet.betId, Date.now());
    });
    sock.on(SOCKET_EVENTS.authExpired, (n: { expiresAt: number }) => expiredNotices.push({ ...n, at: Date.now() }));
    expect(await emitAck(SOCKET_EVENTS.placeBet, { amount: 100, autoX100: null, idempotencyKey: 'anon-bet-0000001' })).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    const token = await freshLogin('renew_a');
    expect(await emitAck(SOCKET_EVENTS.authRenew, { token })).toEqual({ ok: true, expiresAt: expOf(token) });
  });

  it('expiry refuses commands but never cancels a bet: the server settles it at the round outcome', async () => {
    // A token with under a second left, right as a 1.5 s betting window opens, and a bet with a
    // 1.30x auto cash-out: the token always lapses before the round even starts.
    const from = events.length;
    await until(() => events.slice(from).some((e) => e.type === 'round.betting'));
    const token = await freshLogin('renew_a');
    expect((await emitAck<{ ok: boolean }>(SOCKET_EVENTS.authRenew, { token })).ok).toBe(true);
    const placed = await emitAck<{ ok: boolean; bet: { betId: string; roundId: number } }>(SOCKET_EVENTS.placeBet, { amount: 250, autoX100: 130, idempotencyKey: 'renewal-bet-00001' });
    expect(placed.ok).toBe(true);

    // The server tells the client when the token lapses, and refuses commands from then on.
    const notice = await until(() => expiredNotices.find((n) => n.expiresAt === expOf(token)), 3_000);
    expect(Date.now()).toBeGreaterThanOrEqual(notice.expiresAt - 50);
    expect(await emitAck(SOCKET_EVENTS.cashout, { roundId: placed.bet.roundId, idempotencyKey: 'renewal-cash-0001' })).toEqual({ ok: false, error: 'AUTH_EXPIRED' });
    expect(await emitAck(SOCKET_EVENTS.placeBet, { amount: 100, autoX100: null, idempotencyKey: 'renewal-bet-00002' })).toEqual({ ok: false, error: 'AUTH_EXPIRED' });

    // The round still runs its course for this bet: cashed out by the server at 1.30x if the crash
    // allowed it, otherwise lost. An expired token never voids it.
    const settled = await until(() => events.find((e): e is Extract<RoundEvent, { type: 'round.settled' }> => e.type === 'round.settled' && e.roundId === placed.bet.roundId), 30_000);
    const fresh = await freshLogin('renew_a');
    const mine = (await http('/api/me/bets', { token: fresh })).body.find((b: { betId: string }) => b.betId === placed.bet.betId);
    if (settled.crashX100 >= 130) {
      expect(mine).toMatchObject({ status: 'CASHED_OUT', cashoutX100: 130, autoCashout: true, payout: 325 });
      expect(cashedAt.get(placed.bet.betId)).toBeGreaterThan(notice.at); // paid after the token lapsed
    } else {
      expect(mine).toMatchObject({ status: 'LOST', payout: 0 });
    }
  }, 45_000);

  it('renewal restores commands on the same socket without reconnecting', async () => {
    const id = sock.id;
    const token = await freshLogin('renew_a');
    expect(await emitAck(SOCKET_EVENTS.authRenew, { token })).toEqual({ ok: true, expiresAt: expOf(token) });
    const r = await emitAck<{ ok: boolean; error?: string }>(SOCKET_EVENTS.placeBet, { amount: 100, autoX100: null, idempotencyKey: 'renewal-bet-00003' });
    expect(r.error).not.toBe('AUTH_EXPIRED'); // accepted, or refused for a game reason (e.g. BETTING_CLOSED)
    expect(sock.id).toBe(id);
  });

  it('refuses renewal with another player\'s token or an invalid one', async () => {
    expect(await emitAck(SOCKET_EVENTS.authRenew, { token: await login('renew_b') })).toEqual({ ok: false, error: 'IDENTITY_MISMATCH' });
    expect(await emitAck(SOCKET_EVENTS.authRenew, { token: 'not.a.token' })).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(await emitAck(SOCKET_EVENTS.authRenew, {})).toEqual({ ok: false, error: 'VALIDATION_ERROR' });
  });

  it('GET /api/config tells the web app the deployment mode', async () => {
    expect((await http('/api/config')).body).toEqual({ platformMode: false, guestAllowed: true, portalOrigins: [] });
  });
});
