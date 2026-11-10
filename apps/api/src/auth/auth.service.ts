import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import type { Env } from '../config/env';
import { DATA_SOURCE, ENV } from '../config/tokens';
import { PostgresLedger } from '../wallet/postgres-ledger';
import { JwksCache } from '../platform/jwks';
import { JwtError, jwtHeader, signHs256, verifyHs256, verifyRs256 } from './jwt';

export interface Principal {
  userId: string;
  username: string;
}

export const Credentials = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/, '3-20 letters, digits or _'),
  password: z.string().min(8).max(128),
});

/**
 * PLATFORM_MODE=false: own users (argon2id passwords, HS256 session tokens, one-click guests).
 * PLATFORM_MODE=true: trusts platform-core RS256 tokens and links each subject to a local
 * shadow user (external_id) so bets and history still have a local owner.
 */
@Injectable()
export class AuthService {
  private readonly jwks: JwksCache | null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly ledger: PostgresLedger,
  ) {
    this.jwks = env.PLATFORM_JWKS_URL ? new JwksCache(env.PLATFORM_JWKS_URL) : null;
  }

  async register(body: unknown) {
    this.ownUsersOnly();
    const parsed = Credentials.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const { username, password } = parsed.data;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    try {
      const u = await this.ledger.createUser({ username, passwordHash, grantCents: this.env.SIGNUP_GRANT_CENTS });
      return this.session({ userId: u.userId, username }, u.balance);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('username taken');
      throw e;
    }
  }

  async login(body: unknown) {
    this.ownUsersOnly();
    const parsed = Credentials.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException('invalid credentials');
    const [row] = await this.ds.query(
      `SELECT u.id, u.username, u.password_hash, a.balance FROM users u JOIN accounts a ON a.user_id = u.id WHERE u.username = $1 AND NOT u.is_bot`,
      [parsed.data.username],
    );
    // Verify against a dummy hash when the user is unknown to keep timing uniform.
    const hash = row?.password_hash ?? '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy';
    const ok = await argon2.verify(hash, parsed.data.password).catch(() => false);
    if (!row || !row.password_hash || !ok) throw new UnauthorizedException('invalid credentials');
    return this.session({ userId: row.id, username: row.username }, Number(row.balance));
  }

  /** One-click play: a fresh guest with the sign-up grant. */
  async guest() {
    this.ownUsersOnly();
    const username = `guest_${randomBytes(3).toString('hex')}`;
    const u = await this.ledger.createUser({ username, grantCents: this.env.SIGNUP_GRANT_CENTS });
    return this.session({ userId: u.userId, username }, u.balance);
  }

  /** Resolves a bearer token (REST or socket handshake) to a principal, or null when absent/invalid. */
  async verify(token: string | undefined | null): Promise<Principal | null> {
    if (!token) return null;
    try {
      if (this.env.PLATFORM_MODE) return await this.fromPlatformToken(token);
      const claims = verifyHs256(token, this.env.JWT_SECRET);
      return { userId: claims.sub, username: String(claims.username ?? '') };
    } catch (e) {
      if (e instanceof JwtError) return null;
      throw e;
    }
  }

  async require(authorization: string | undefined): Promise<Principal> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const p = await this.verify(token);
    if (!p) throw new UnauthorizedException();
    return p;
  }

  private session(p: Principal, balance: number) {
    const token = signHs256({ sub: p.userId, username: p.username }, this.env.JWT_SECRET, this.env.JWT_TTL_SECONDS);
    return { token, user: { id: p.userId, username: p.username, balance } };
  }

  private async fromPlatformToken(token: string): Promise<Principal> {
    // Core publishes rotating keys at its JWKS endpoint; a static PEM is the offline fallback.
    const key = this.jwks
      ? await this.jwks.key(jwtHeader(token).kid)
      : this.env.PLATFORM_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
    if (!key) throw new JwtError('no platform signing key configured');
    const claims = verifyRs256(token, key, {
      issuer: this.env.PLATFORM_JWT_ISSUER,
      audience: this.env.PLATFORM_JWT_AUDIENCE,
    });
    // Machine tokens (client credentials) never act as players.
    if (claims.kind !== undefined && claims.kind !== 'user') throw new JwtError('not a user token');
    const [row] = await this.ds.query(`SELECT id, username FROM users WHERE external_id = $1`, [claims.sub]);
    if (row) return { userId: row.id, username: row.username };
    const email = typeof claims.email === 'string' ? claims.email : '';
    const base = (email.split('@')[0] || `p_${claims.sub.slice(0, 8)}`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 14);
    // Money lives in platform-core in this mode; the local account only mirrors bets (grant 0).
    const u = await this.ledger.createUser({ username: `${base}_${claims.sub.slice(0, 4)}`, externalId: claims.sub, grantCents: 0 });
    return { userId: u.userId, username: `${base}_${claims.sub.slice(0, 4)}` };
  }

  private ownUsersOnly(): void {
    if (this.env.PLATFORM_MODE) throw new BadRequestException('users are managed by platform-core in PLATFORM_MODE');
  }
}
