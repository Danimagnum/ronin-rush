import { defineConfig, devices } from '@playwright/test';
import { E2E, apiUrl, webUrl } from './env';

/**
 * Runs the built API and web app (not dev servers) against an isolated database and Redis,
 * then drives Chromium like a player. Build first: `pnpm build`.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // one shared live round: tests run one after another
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: 'node prepare.mjs && node ../apps/api/dist/main.js',
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(E2E.apiPort),
        INSTANCE_ID: 'e2e-api',
        DATABASE_URL: E2E.databaseUrl,
        REDIS_URL: E2E.redisUrl,
        REDIS_NAMESPACE: E2E.redisNamespace,
        GROWTH_K: String(E2E.growthK),
        BETTING_MS: '4000',
        RESULT_MS: '1500',
        CHAIN_LENGTH: '2000',
        CHAIN_TERMINAL_SEED: 'c4'.repeat(32),
        BOTS_COUNT: '3',
        KAFKA_BROKERS: '',
      },
    },
    {
      // NEXT_PUBLIC_* is inlined at build time, so the web app is built for the e2e API port.
      command: `pnpm --filter @ronin/web exec next build && pnpm --filter @ronin/web exec next start -p ${E2E.webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { NEXT_PUBLIC_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
