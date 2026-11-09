import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { multiplierX100At, sha256Hex, SOCKET_EVENTS, type RoundEvent, type ServerHello } from '@ronin/shared';
import Redis from 'ioredis';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Black-box test of the built API: two real instances (one leader, one relay) on a fresh
 * database and Redis DB, a Socket.IO client connected to the *relay* so every command crosses
 * the Redis command bus. Requires `pnpm build`, TEST_DATABASE_URL and REDIS_URL.
 */
const DIST = join(__dirname, '..', 'dist', 'main.js');
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_BASE = process.env.REDIS_URL;
const enabled = Boolean(DB_URL && REDIS_BASE && existsSync(DIST));

const K = 0.0005; // 2.00x at ~1.4 s: fast rounds
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('real-time API, two instances (e2e)', () => {
  const procs = new Map<string, ChildProcess>();
  const logs = new Map<string, string>();
  let e2eDbUrl: string;
  let redisUrl: string;
  let leaderPort = 0;
  let relayPort = 0;
  let sock: Socket;
  const events: RoundEvent[] = [];
  const balances: number[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const http = async (port: number, path: string, init?: { method?: string; body?: unknown; token?: string }): Promise<{ status: number; body: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init?.body ? JSON.stringify(init.body) : null,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  function startInstance(name: string, port: number) {
    const p = spawn(process.execPath, [DIST], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INSTANCE_ID: name,
        PORT: String(port),
        DATABASE_URL: e2eDbUrl,
        REDIS_URL: redisUrl,
        BETTING_MS: '1500',
        RESULT_MS: '600',
        GROWTH_K: String(K),
        CHAIN_LENGTH: '2000',
        CHAIN_TERMINAL_SEED: 'b7'.repeat(32),
        LEADER_TTL_MS: '1500',
        LEADER_RENEW_MS: '300',
        BOTS_COUNT: '4',
        KAFKA_BROKERS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logs.set(name, '');
    p.stdout!.on('data', (d) => logs.set(name, logs.get(name) + d.toString()));
    p.stderr!.on('data', (d) => logs.set(name, logs.get(name) + d.toString()));
    procs.set(name, p);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const health = (port: number): Promise<any> => http(port, '/health').then((r) => r.body).catch(() => null);
  async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v as T;
      await sleep(25);
    }
    throw new Error('timeout');
  }
  const nextEvent = <T extends RoundEvent['type']>(type: T, pred: (e: Extract<RoundEvent, { type: T }>) => boolean = () => true, from = events.length) =>
    until(() => events.slice(from).find((e): e is Extract<RoundEvent, { type: T }> => e.type === type && pred(e as never)));

  /** Server time as seen by the client, from the NTP-style ping. */
  let offset = 0;
  const serverNow = () => Date.now() + offset;
  const emitAck = <T>(event: string, payload: unknown) =>
    new Promise<T>((resolve) => sock.timeout(5_000).emit(event, payload, (err: unknown, res: T) => resolve(err ? ({ ok: false, error: 'TIMEOUT' } as T) : res)));

  beforeAll(async () => {
    // Fresh database and Redis DB 1 (DB 0 is used by the unit suites).
    const admin = new Client({ connectionString: DB_URL!.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ronin_e2e WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ronin_e2e`);
    await admin.end();
    e2eDbUrl = DB_URL!.replace(/\/[^/]+$/, '/ronin_e2e');
    redisUrl = REDIS_BASE!.replace(/\/\d*$/, '') + '/1';
    const r = new Redis(redisUrl);
    await r.flushdb();
    r.disconnect();

    startInstance('e2e-a', 3201);
    await until(async () => (await health(3201))?.leader === true);
    startInstance('e2e-b', 3202);
    await until(async () => (await health(3202))?.status === 'ok');
    leaderPort = 3201;
    relayPort = 3202;
  }, 60_000);

  afterAll(async () => {
    sock?.disconnect();
    for (const p of procs.values()) p.kill('SIGTERM');
    await sleep(500);
  });

  it('has exactly one leader', async () => {
    const [a, b] = await Promise.all([health(leaderPort), health(relayPort)]);
    expect([a.leader, b.leader]).toEqual([true, false]);
  });

  it('guest login and socket hello on the relay instance', async () => {
    const { status, body } = await http(relayPort, '/api/auth/guest', { method: 'POST' });
    expect(status).toBe(201);
    const token = body.token as string;

    sock = io(`http://127.0.0.1:${relayPort}`, { transports: ['websocket'], auth: { token } });
    sock.on(SOCKET_EVENTS.roundEvent, (e: RoundEvent) => events.push(e));
    sock.on(SOCKET_EVENTS.balance, (b: { balance: number }) => balances.push(b.balance));
    const hello = await new Promise<ServerHello>((resolve) => sock.once(SOCKET_EVENTS.hello, resolve));
    expect(hello.instanceId).toBe('e2e-b');
    expect(hello.user).toMatchObject({ username: body.user.username, balance: 100_000 });
    expect(hello.fairness.commitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it('syncs the clock over ping/pong', async () => {
    const samples: Array<{ rtt: number; offset: number }> = [];
    for (let i = 0; i < 8; i++) {
      const c0 = Date.now();
      const pong = await emitAck<{ c0: number; s1: number; s2: number }>(SOCKET_EVENTS.timePing, { c0 });
      const c3 = Date.now();
      samples.push({ rtt: c3 - c0 - (pong.s2 - pong.s1), offset: (pong.s1 - c0 + (pong.s2 - c3)) / 2 });
    }
    samples.sort((a, b) => a.rtt - b.rtt);
    offset = samples[0]!.offset;
    expect(samples[0]!.rtt).toBeLessThan(50);
    expect(Math.abs(offset)).toBeLessThan(50); // same machine; Redis-aligned clock ≈ wall clock
  });

  it('bet -> cash out through the relay is paid at m(server receive time)', async () => {
    const betting = await nextEvent('round.betting', (e) => e.bettingEndsAt - serverNow() > 600);
    const placed = await emitAck<{ ok: boolean; bet: { betId: string; roundId: number }; error?: string }>(SOCKET_EVENTS.placeBet, {
      amount: 1_000,
      idempotencyKey: `e2e-bet-${betting.roundId}`,
    });
    expect(placed).toMatchObject({ ok: true, bet: { roundId: betting.roundId } });
    await until(() => balances.includes(99_000));

    const started = await nextEvent('round.started', (e) => e.roundId === betting.roundId);
    // Wait until ~1.10x locally, then click.
    await until(() => serverNow() - started.startedAt > 200 || events.some((e) => e.type === 'round.crashed' && e.roundId === betting.roundId));
    const sentAt = serverNow();
    const res = await emitAck<{ ok: boolean; bet?: { cashoutX100: number; payout: number }; error?: string }>(SOCKET_EVENTS.cashout, {
      roundId: betting.roundId,
      idempotencyKey: `e2e-co-${betting.roundId}`,
    });
    const ackAt = serverNow();
    if (process.env.E2E_DEBUG) console.log('cash-out result', JSON.stringify(res), 'elapsed at send', sentAt - started.startedAt);
    if (!res.ok) {
      // The only acceptable failure: the crash instant came before our click reached the server.
      // The rejection can arrive before the crashed broadcast (the click may be processed while
      // the crash timer is still pending), so wait for the event and compare instants.
      expect(res.error).toBe('CASHOUT_AFTER_CRASH');
      const crashed = await nextEvent('round.crashed', (e) => e.roundId === betting.roundId, 0);
      expect(crashed.crashedAt).toBeLessThanOrEqual(ackAt + 30);
      return;
    }
    const x = res.bet!.cashoutX100;
    // The server's multiplier lies between m(send) and m(ack), within clock-offset slack.
    expect(x).toBeGreaterThanOrEqual(multiplierX100At(sentAt - started.startedAt - 30, K));
    expect(x).toBeLessThanOrEqual(multiplierX100At(ackAt - started.startedAt + 30, K));
    expect(res.bet!.payout).toBe(Math.floor((1_000 * x) / 100));
    await until(() => balances.includes(99_000 + res.bet!.payout));
  });

  it('a cash-out arriving after the crash is rejected', async () => {
    const betting = await nextEvent('round.betting', (e) => e.bettingEndsAt - serverNow() > 600);
    const placed = await emitAck<{ ok: boolean }>(SOCKET_EVENTS.placeBet, { amount: 500, idempotencyKey: `e2e-late-${betting.roundId}` });
    expect(placed.ok).toBe(true);
    await nextEvent('round.crashed', (e) => e.roundId === betting.roundId);
    const res = await emitAck<{ ok: boolean; error?: string }>(SOCKET_EVENTS.cashout, {
      roundId: betting.roundId,
      idempotencyKey: `e2e-late-co-${betting.roundId}`,
    });
    expect(res).toEqual({ ok: false, error: 'CASHOUT_AFTER_CRASH' });
  });

  it('rejects commands from unauthenticated sockets and malformed payloads', async () => {
    const anon = io(`http://127.0.0.1:${relayPort}`, { transports: ['websocket'] });
    await new Promise((r) => anon.once(SOCKET_EVENTS.hello, r));
    const res = await new Promise((r) => anon.emit(SOCKET_EVENTS.placeBet, { amount: 100, idempotencyKey: 'anon-key-1' }, r));
    expect(res).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    anon.disconnect();
    expect(await emitAck(SOCKET_EVENTS.placeBet, { amount: -5, idempotencyKey: 'x' })).toEqual({ ok: false, error: 'VALIDATION_ERROR' });
  });

  it('bots keep the table alive, the read model is served by the relay, and the books balance', async () => {
    await until(() => events.some((e) => e.type === 'bet.placed' && e.bet.isBot));
    const snap = await http(relayPort, '/api/round');
    expect(snap.status).toBe(200);
    const recent = await http(relayPort, '/api/rounds/recent');
    const ids = recent.body.map((r: { roundId: number }) => r.roundId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a)); // newest first
    const lastSettled = [...events].reverse().find((e) => e.type === 'round.settled') as Extract<RoundEvent, { type: 'round.settled' }>;
    expect(ids[0]).toBeGreaterThanOrEqual(lastSettled.roundId); // not lagging behind the live stream
    expect(recent.body[0].seedHash).toBe(sha256Hex(recent.body[0].seed));

    const lb = await http(relayPort, '/api/leaderboard');
    expect(lb.body).toHaveProperty('bestMultiplier');

    const audit = await until(async () => {
      const a = (await http(relayPort, '/api/ledger/audit')).body;
      return a && a.totalPostings === 0 && a.cacheMismatches.length === 0 ? a : null;
    });
    expect(audit.transactions).toBeGreaterThan(5);

    const r = new Redis(redisUrl);
    expect(await r.llen('ronin:kafka:tap')).toBeGreaterThan(0); // outbox relay (dry-run) is draining
    r.disconnect();
  });

  it('survives a leader crash: the relay takes over and the socket keeps receiving rounds', async () => {
    procs.get('e2e-a')!.kill('SIGKILL');
    await until(async () => (await health(relayPort))?.leader === true, 10_000);
    const from = events.length;
    const betting = await nextEvent('round.betting', () => true, from);
    expect(betting.roundId).toBeGreaterThan(1);
    const placed = await emitAck<{ ok: boolean; error?: string }>(SOCKET_EVENTS.placeBet, { amount: 100, idempotencyKey: `e2e-after-${betting.roundId}` });
    expect(placed.ok || placed.error === 'BETTING_CLOSED').toBe(true);
    await nextEvent('round.settled', (e) => e.roundId >= betting.roundId, from);
  }, 30_000);
});
