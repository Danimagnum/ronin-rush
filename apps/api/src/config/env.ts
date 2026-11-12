import { hostname } from 'node:os';
import { DEFAULT_GROWTH_PER_MS, GAME_DEFAULTS } from '@ronin/shared';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  /**
   * Prefix for Redis pub/sub channels (Socket.IO adapter, command replies). Pub/sub ignores the
   * logical DB number, so two environments sharing one Redis server must use different values.
   */
  REDIS_NAMESPACE: z.string().regex(/^[a-z0-9-]+$/).default('ronin'),
  DATABASE_URL: z.string().url().default('postgres://ronin:ronin@localhost:5432/ronin'),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(20),
  MIGRATE_ON_BOOT: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** Play money credited on sign-up (cents). */
  SIGNUP_GRANT_CENTS: z.coerce.number().int().nonnegative().default(100_000),

  PUBLIC_SALT: z.string().min(8).default('ronin-rush-public-salt-v1'),
  GROWTH_K: z.coerce.number().positive().default(DEFAULT_GROWTH_PER_MS),
  BETTING_MS: z.coerce.number().int().positive().default(GAME_DEFAULTS.bettingMs),
  RESULT_MS: z.coerce.number().int().positive().default(GAME_DEFAULTS.resultMs),
  DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(GAME_DEFAULTS.drainTimeoutMs),

  /** Dev only: deterministic chain. Otherwise a random chain is generated once on first boot and stored. */
  CHAIN_TERMINAL_SEED: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  CHAIN_LENGTH: z.coerce.number().int().positive().default(100_000),

  LEADER_TTL_MS: z.coerce.number().int().positive().default(5_000),
  LEADER_RENEW_MS: z.coerce.number().int().positive().default(1_000),
  CLOCK_SYNC_MS: z.coerce.number().int().positive().default(5_000),

  PLATFORM_MODE: bool,
  /** Service name used as the event `source` and in health reports (platform-infra contract). */
  SERVICE_NAME: z.string().regex(/^[a-z][a-z0-9-]*$/).default('ronin-rush'),
  /** platform-core base URL (legacy wallet routes live under /v1/wallet). */
  CORE_URL: z.string().url().optional(),
  /** OAuth token endpoint for client credentials; defaults to CORE_URL + /oauth/token. */
  CORE_TOKEN_URL: z.string().url().optional(),
  /** Core JWKS, issuer and audience: user tokens are verified against all three (fail closed). */
  CORE_JWKS_URL: z.string().url().optional(),
  CORE_ISSUER: z.string().min(1).optional(),
  CORE_AUDIENCE: z.string().min(1).optional(),
  CORE_CLIENT_ID: z.string().optional(),
  CORE_CLIENT_SECRET: z.string().optional(),
  /** Ronin's service id in Core's provisioning, used for player activation. Defaults to CORE_CLIENT_ID. */
  CORE_SERVICE_ID: z.string().min(1).optional(),
  /** Lifetime of a stake hold in Core. Settlement stays possible 1800 s beyond it. */
  CORE_HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  /** No longer used: /api/v1 settle credits Core's provisioned house itself. Accepted and ignored. */
  CORE_HOUSE_ACCOUNT_ID: z.string().optional(),
  CORE_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  /**
   * Origins of the platform portal(s) that may hand the embedded game a renewed Core token via
   * window.postMessage (comma-separated, exact origins). Empty: no in-page renewal.
   */
  PORTAL_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(z.string().url())),

  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),

  /** Comma-separated brokers; empty = outbox relay runs in dry-run mode (marks + taps, no Kafka). */
  KAFKA_BROKERS: z.string().default(''),
  KAFKA_CLIENT_ID: z.string().default('ronin-rush-api'),
  /** Read the events back with a consumer group and show offsets in the System view. */
  KAFKA_CONSUMER_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  KAFKA_PARTITIONS: z.coerce.number().int().positive().default(3),

  BOTS_COUNT: z.coerce.number().int().min(0).max(100).default(12),
  CORS_ORIGIN: z.string().default('*'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.JWT_SECRET === 'dev-only-insecure-secret-change-me') {
    ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'must be set in production' });
  }
  if (env.PLATFORM_MODE) {
    for (const k of ['CORE_URL', 'CORE_JWKS_URL', 'CORE_ISSUER', 'CORE_AUDIENCE', 'CORE_CLIENT_ID', 'CORE_CLIENT_SECRET'] as const) {
      if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when PLATFORM_MODE=true' });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

/** Pre-0.2.0 names, still accepted so existing deployments keep working. The CORE_* name wins. */
export const LEGACY_ENV_ALIASES: Record<string, string> = {
  CORE_URL: 'PLATFORM_CORE_URL',
  CORE_JWKS_URL: 'PLATFORM_JWKS_URL',
  CORE_ISSUER: 'PLATFORM_JWT_ISSUER',
  CORE_AUDIENCE: 'PLATFORM_JWT_AUDIENCE',
  CORE_CLIENT_ID: 'PLATFORM_CLIENT_ID',
  CORE_CLIENT_SECRET: 'PLATFORM_CLIENT_SECRET',
  CORE_HOUSE_ACCOUNT_ID: 'PLATFORM_HOUSE_ACCOUNT_ID',
  CORE_CURRENCY: 'PLATFORM_CURRENCY',
};

export function withLegacyAliases(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...source };
  for (const [name, legacy] of Object.entries(LEGACY_ENV_ALIASES)) {
    if (!out[name] && out[legacy]) out[name] = out[legacy];
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(withLegacyAliases(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
