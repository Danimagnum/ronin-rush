import { DataSource } from 'typeorm';
import { InitialSchema1762675200000 } from './migrations/1762675200000-InitialSchema';
import { PlatformSettlements1762934400000 } from './migrations/1762934400000-PlatformSettlements';
import { OutboxRejected1763251200000 } from './migrations/1763251200000-OutboxRejected';

export const MIGRATIONS = [InitialSchema1762675200000, PlatformSettlements1762934400000, OutboxRejected1763251200000];

export function createDataSource(url: string, opts: { poolSize?: number; searchPath?: string } = {}): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: ['error'],
    extra: { max: opts.poolSize ?? 20, ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}) },
  });
}

/** Used by the TypeORM CLI: `pnpm --filter @ronin/api migration:run`. */
export default createDataSource(process.env.DATABASE_URL ?? 'postgres://ronin:ronin@localhost:5432/ronin');
