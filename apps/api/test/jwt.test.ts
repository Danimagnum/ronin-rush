import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JwtError, signHs256, verifyHs256, verifyRs256 } from '../src/auth/jwt';

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

describe('RS256 platform-core tokens', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sign = (claims: object) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const exp = Math.floor(Date.now() / 1000) + 60;

  it('verifies signature, issuer and audience', () => {
    const t = sign({ sub: 'player-42', iss: 'platform-core', aud: 'ronin-rush', exp });
    expect(verifyRs256(t, pem, { issuer: 'platform-core', audience: 'ronin-rush' }).sub).toBe('player-42');
    expect(() => verifyRs256(t, pem, { issuer: 'someone-else' })).toThrow(/issuer/);
    expect(() => verifyRs256(t, pem, { audience: 'other-game' })).toThrow(/audience/);
  });

  it('rejects an HS256 token signed with the public key (alg confusion)', () => {
    const t = signHs256({ sub: 'evil' }, pem, 60);
    expect(() => verifyRs256(t, pem)).toThrow(/alg/);
  });
});
