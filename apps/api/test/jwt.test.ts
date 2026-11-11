import { describe, expect, it } from 'vitest';
import { JwtError, signHs256, verifyHs256 } from '../src/auth/jwt';

const SECRET = 'a-very-long-test-secret';

describe('HS256 session tokens', () => {
  it('round-trips claims and rejects tampering, wrong secret and expiry', () => {
    const t = signHs256({ sub: 'u1', username: 'ren' }, SECRET, 60);
    expect(verifyHs256(t, SECRET)).toMatchObject({ sub: 'u1', username: 'ren' });

    const [h, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9_999_999_999 })).toString('base64url');
    expect(() => verifyHs256(`${h}.${forged}.${s}`, SECRET)).toThrow(JwtError);
    expect(() => verifyHs256(t, 'another-secret-entirely')).toThrow(/signature/);
    expect(() => verifyHs256(t, SECRET, Date.now() + 61_000)).toThrow(/expired/);
    expect(() => verifyHs256(`${h}.${p}`, SECRET)).toThrow(/malformed/);
  });

  it('cannot be downgraded to alg=none', () => {
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', exp: 9_999_999_999 })).toString('base64url');
    expect(() => verifyHs256(`${none}.${payload}.`, SECRET)).toThrow(JwtError);
  });
});
