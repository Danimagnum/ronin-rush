/** One place for the e2e stack's ports and isolated resources (its own DB, Redis DB and pub/sub namespace). */
export const E2E = {
  apiPort: Number(process.env.E2E_API_PORT ?? 3301),
  webPort: Number(process.env.E2E_WEB_PORT ?? 3300),
  databaseUrl: process.env.E2E_DATABASE_URL ?? 'postgres://ronin:ronin@localhost:5432/ronin_e2e_web',
  redisUrl: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/4',
  redisNamespace: 'ronin-pw',
  /** Fast curve: 2.00x after ~1.4 s, so rounds are short and the suite stays quick. */
  growthK: 0.0005,
};
export const apiUrl = `http://localhost:${E2E.apiPort}`;
export const webUrl = `http://localhost:${E2E.webPort}`;
