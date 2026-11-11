import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { loadEnv } from '../src/config/env';
import { PostgresLedger } from '../src/wallet/postgres-ledger';
import { TEST_DATABASE_URL, freshSchema } from './db';

const ISSUER = 'https://core.test';
const AUDIENCE = 'ronin-rush';

interface Key {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function newKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function sign(key: Key, claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'RS256', typ: 'JWT', kid: key.kid })}.${b64(claims)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(key.privateKey).toString('base64url')}`;
}

/** A Core user access token: the claims the contract's verifier requires (600 s TTL). */
function userToken(key: Key, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return sign(key, {
    sub: 'user-0001',
    email: 'player@example.com',
    roles: ['player'],
    kycStatus: 'verified',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 600,
    ...over,
  });
}

describe.skipIf(!TEST_DATABASE_URL)('PLATFORM_MODE auth with the contract verifier (real JWKS over HTTP)', () => {
  let ds: DataSource;
  let auth: AuthService;
  let server: Server;
  let published: Key[] = [];
  let jwksFetches = 0;
  const k1 = newKey('core-2026-11-a');
  const k2 = newKey('core-2026-11-b');

  beforeAll(async () => {
    ds = await freshSchema('t_platform_auth');
    server = createServer((req, res) => {
      if (req.url !== '/.well-known/jwks.json') return res.writeHead(404).end();
      jwksFetches++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: published.map((k) => k.jwk) }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = loadEnv({
      PLATFORM_MODE: 'true',
      CORE_URL: base,
      CORE_JWKS_URL: `${base}/.well-known/jwks.json`,
      CORE_ISSUER: ISSUER,
      CORE_AUDIENCE: AUDIENCE,
      CORE_CLIENT_ID: 'ronin-rush',
      CORE_CLIENT_SECRET: 'secret',
      CORE_HOUSE_ACCOUNT_ID: '00000000-0000-4000-8000-0000000000aa',
    });
    const ledger = new PostgresLedger(ds);
    await ledger.init();
    auth = new AuthService(env, ds, ledger);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    server?.close();
    await ds?.destroy();
  });

  it('accepts a valid user token, maps it to one shadow user and reports its expiry', async () => {
    published = [k1];
    const token = userToken(k1);
    const p = await auth.verify(token);
    expect(p).toMatchObject({ username: 'player_user' });
    expect(p!.expiresAt).toBe(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).exp * 1000);
    // Same subject again: same local user, no duplicate shadow account.
    expect((await auth.verify(userToken(k1)))!.userId).toBe(p!.userId);
    const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM users WHERE external_id = 'user-0001'`);
    expect(n).toBe(1);
  });

  it('fails closed: wrong issuer, wrong audience, expired, tampered or unknown-key tokens', async () => {
    published = [k1];
    const now = Math.floor(Date.now() / 1000);
    expect(await auth.verify(userToken(k1, { iss: 'https://someone-else.test' }))).toBeNull();
    expect(await auth.verify(userToken(k1, { aud: 'other-game' }))).toBeNull();
    expect(await auth.verify(userToken(k1, { iat: now - 700, exp: now - 100 }))).toBeNull();
    const [h, , s] = userToken(k1).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'user-9999', email: 'x@example.com', roles: [], kycStatus: 'verified', iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 600 })).toString('base64url');
    expect(await auth.verify(`${h}.${forged}.${s}`)).toBeNull();
    expect(await auth.verify(userToken(newKey('not-published')))).toBeNull();
  });

  it('never lets a machine (client-credentials) token act as a player', async () => {
    published = [k1];
    const now = Math.floor(Date.now() / 1000);
    const machine = sign(k1, { sub: 'svc-dropzone', client_id: 'svc-dropzone', scope: 'wallet:read', iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 600 });
    expect(await auth.verify(machine)).toBeNull();
  });

  it('follows key rotation: a newly published kid is accepted, the retired one stops working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    published = [k1];
    expect(await auth.verify(userToken(k1))).not.toBeNull();
    // Core publishes the next key alongside the current one (overlap), then starts signing with it.
    published = [k1, k2];
    vi.setSystemTime(Date.now() + 31_000);
    const before = jwksFetches;
    expect(await auth.verify(userToken(k2))).not.toBeNull();
    expect(jwksFetches).toBeGreaterThan(before); // unknown kid → JWKS refetched
    expect(await auth.verify(userToken(k1))).not.toBeNull(); // still inside the overlap
    // k1 retired: once the cached key set expires, k1 tokens are refused.
    published = [k2];
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await auth.verify(userToken(k2))).not.toBeNull();
    expect(await auth.verify(userToken(k1))).toBeNull();
  });
});
