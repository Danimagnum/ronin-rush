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

  PUBLIC_SALT: z.string().min(8).default('ronin-rush-public-salt-v1'),
  GROWTH_K: z.coerce.number().positive().default(DEFAULT_GROWTH_PER_MS),
  BETTING_MS: z.coerce.number().int().positive().default(GAME_DEFAULTS.bettingMs),
  RESULT_MS: z.coerce.number().int().positive().default(GAME_DEFAULTS.resultMs),
  DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(GAME_DEFAULTS.drainTimeoutMs),

  /** Dev only: deterministic chain. Production chains are generated once and stored (wallet milestone). */
  CHAIN_TERMINAL_SEED: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  CHAIN_LENGTH: z.coerce.number().int().positive().default(10_000),

  LEADER_TTL_MS: z.coerce.number().int().positive().default(5_000),
  LEADER_RENEW_MS: z.coerce.number().int().positive().default(1_000),
  CLOCK_SYNC_MS: z.coerce.number().int().positive().default(5_000),

  PLATFORM_MODE: bool,
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
