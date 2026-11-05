import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, hmacSha256, sha256, utf8 } from '../src/index.js';

const hex = (s: string) => bytesToHex(sha256(utf8(s)));

describe('sha256 (FIPS 180-4 test vectors)', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ])('sha256(%j)', (input, expected) => expect(hex(input)).toBe(expected));

  it('handles one million "a" (multi-block)', () => {
    expect(hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('handles every padding boundary (55/56/63/64/65 bytes)', async () => {
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31) & 0xff);
      const ref = bytesToHex(await crypto.subtle.digest('SHA-256', data));
      expect(bytesToHex(sha256(data)), `length ${n}`).toBe(ref);
    }
  });
});

describe('hmacSha256 (RFC 4231 test cases)', () => {
  it('case 1', () => {
    const key = hexToBytes('0b'.repeat(20));
    expect(bytesToHex(hmacSha256(key, utf8('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
  it('case 2 (short key)', () => {
    expect(bytesToHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
  it('case 6 (key longer than block size)', () => {
    const key = hexToBytes('aa'.repeat(131));
    expect(bytesToHex(hmacSha256(key, utf8('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });
});

describe('cross-check against Web Crypto', () => {
  it('agrees on 2,000 random seeds / messages', async () => {
    for (let i = 0; i < 2000; i++) {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const msg = crypto.getRandomValues(new Uint8Array(i % 150));
      const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const ref = bytesToHex(await crypto.subtle.sign('HMAC', k, msg));
      expect(bytesToHex(hmacSha256(key, msg))).toBe(ref);
      expect(bytesToHex(sha256(msg))).toBe(bytesToHex(await crypto.subtle.digest('SHA-256', msg)));
    }
  });
});
