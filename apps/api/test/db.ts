import { createDataSource } from '../src/db/data-source';
import type { DataSource } from 'typeorm';

/** Real PostgreSQL (TEST_DATABASE_URL, e.g. the compose service). Suites skip when absent. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Fresh, migrated schema per test file so suites can run in parallel on one database. */
export async function freshSchema(name: string, poolSize = 30): Promise<DataSource> {
  const admin = createDataSource(TEST_DATABASE_URL!, { poolSize: 1 });
  await admin.initialize();
  await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.destroy();
  const ds = createDataSource(TEST_DATABASE_URL!, { poolSize, searchPath: name });
  await ds.initialize();
  await ds.runMigrations();
  return ds;
}
