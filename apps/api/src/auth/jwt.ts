import { createHmac, createVerify, timingSafeEqual, type KeyObject } from 'node:crypto';

/**
 * Minimal JWT (RFC 7519) helpers on node:crypto — HS256 for our own sessions and RS256
 * verification for platform-core tokens in PLATFORM_MODE. Kept dependency-free and small
 * enough to audit: alg is pinned per call (never read from the header), exp/nbf/iss/aud checked.
 */

export interface JwtClaims {
  sub: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  [k: string]: unknown;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

export class JwtError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'JwtError';
  }
}

export function signHs256(claims: JwtClaims, secret: string, ttlSeconds: number, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function split(token: string): [string, string, string] {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  return parts as [string, string, string];
}

function checkClaims(payload: string, opts: { issuer?: string; audience?: string }, now: number): JwtClaims {
  let claims: JwtClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch {
    throw new JwtError('malformed payload');
  }
  const t = Math.floor(now / 1000);
  if (typeof claims.sub !== 'string' || !claims.sub) throw new JwtError('missing sub');
  if (typeof claims.exp !== 'number' || claims.exp <= t) throw new JwtError('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > t + 5) throw new JwtError('not yet valid');
  if (opts.issuer && claims.iss !== opts.issuer) throw new JwtError('bad issuer');
  if (opts.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) throw new JwtError('bad audience');
  }
  return claims;
}

export function verifyHs256(token: string, secret: string, now = Date.now()): JwtClaims {
  const [header, payload, sig] = split(token);
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError('bad signature');
  return checkClaims(payload, {}, now);
}

/** Unverified header, only to pick a key by `kid`; never trusted for the algorithm. */
export function jwtHeader(token: string): { kid?: string; alg?: string } {
  try {
    return JSON.parse(fromB64url(split(token)[0]).toString('utf8'));
  } catch {
    throw new JwtError('malformed header');
  }
}

export function verifyRs256(
  token: string,
  publicKeyPem: string | KeyObject,
  opts: { issuer?: string; audience?: string } = {},
  now = Date.now(),
): JwtClaims {
  const [header, payload, sig] = split(token);
  const h = JSON.parse(fromB64url(header).toString('utf8'));
  if (h.alg !== 'RS256') throw new JwtError('unexpected alg');
  const ok = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKeyPem, fromB64url(sig));
  if (!ok) throw new JwtError('bad signature');
  return checkClaims(payload, opts, now);
}
