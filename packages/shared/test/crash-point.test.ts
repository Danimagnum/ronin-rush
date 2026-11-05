import { describe, expect, it } from 'vitest';
import { crashPointFromHmac, crashPointX100, formatX100 } from '../src/index.js';

const pad = (prefix: string) => prefix.padEnd(64, '0');

describe('crashPointFromHmac', () => {
  it('clamps to 1.00x when 99 / (1 - U) < 1', () => {
    expect(crashPointFromHmac(pad('0000000000000')).crashX100).toBe(100);
    // U just under 0.01 still floors below 100 cents -> clamped
    const h = (1n << 52n) / 100n - 1n;
    expect(crashPointFromHmac(pad(h.toString(16).padStart(13, '0'))).crashX100).toBe(100);
  });

  it('is exactly 1.98x at U = 0.5', () => {
    expect(crashPointFromHmac(pad('8000000000000')).crashX100).toBe(198);
  });

  it('only reads the first 52 bits (13 hex chars)', () => {
    const a = crashPointFromHmac('8000000000000' + '0'.repeat(51));
    const b = crashPointFromHmac('8000000000000' + 'f'.repeat(51));
    expect(a.crashX100).toBe(b.crashX100);
  });

  it('handles the maximum h without overflow (exact bigint)', () => {
    const r = crashPointFromHmac(pad('fffffffffffff'));
    expect(r.crashX100Big).toBe(99n * (1n << 52n));
  });

  it('rejects malformed digests', () => {
    expect(() => crashPointFromHmac('xyz')).toThrow(TypeError);
    expect(() => crashPointFromHmac('abc')).toThrow(TypeError);
  });
});

describe('crashPointX100 (HMAC-SHA256 via Web Crypto)', () => {
  // Reference values computed independently with Python's hashlib/hmac.
  const salt = 'ronin-rush-public-salt-v1';
  const vectors: Array<[string, number]> = [
    ['e164c85c14833e6944429a8b9d8470a652946c8c987796542b8652efa19a237c', 413],
    ['71f83760695e7151f22441c3a2746350c9292895383e0113a7b25b12716823c1', 471],
    ['a82034b8a79626597f2609213f76ae87d25cfbb884b3c68472035a700d773aa0', 269],
    ['52fe6094743bfd4f9be4321d98adc7e23c1ab622b0ba830e271d1ee1cbfd7850', 612],
    ['a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 536],
  ];

  it.each(vectors)('seed %s -> %i', (seed, expected) => {
    expect(crashPointX100(seed, salt)).toBe(expected);
  });

  it('depends on the salt', () => {
    const [seed] = vectors[0]!;
    expect(crashPointX100(seed, 'other-salt')).not.toBe(413);
  });
});

describe('formatX100', () => {
  it.each([
    [100, '1.00'],
    [101, '1.01'],
    [341, '3.41'],
    [10000, '100.00'],
  ])('%i -> %s', (x, s) => expect(formatX100(x)).toBe(s));
});
