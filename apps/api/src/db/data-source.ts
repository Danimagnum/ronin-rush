import { DataSource } from 'typeorm';
import { InitialSchema1762675200000 } from './migrations/1762675200000-InitialSchema';

export const MIGRATIONS = [InitialSchema1762675200000];

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
