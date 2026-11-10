import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { JwtError } from '../auth/jwt';

/**
 * Resolves platform-core's RS256 signing keys by `kid` from its JWKS endpoint.
 * Keys are cached; an unknown kid triggers at most one refetch per 30 s (key rotation),
 * and verification fails closed when the key can't be resolved.
 */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async key(kid: string | undefined): Promise<KeyObject> {
    if (!kid) throw new JwtError('missing kid');
    let k = this.keys.get(kid);
    if (!k && Date.now() - this.fetchedAt > 30_000) {
      await this.refresh();
      k = this.keys.get(kid);
    }
    if (!k) throw new JwtError('unknown signing key');
    return k;
  }

  private refresh(): Promise<void> {
    this.pending ??= (async () => {
      try {
        const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(3_000) });
        if (!res.ok) throw new JwtError(`JWKS ${res.status}`);
        const { keys } = (await res.json()) as { keys: Array<JsonWebKey & { kid?: string; kty?: string; use?: string }> };
        const next = new Map<string, KeyObject>();
        for (const jwk of keys ?? []) {
          if (!jwk.kid || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue;
          next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        }
        this.keys = next;
        this.fetchedAt = Date.now();
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}
