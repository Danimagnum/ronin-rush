import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Env } from '../config/env';
import { DATA_SOURCE, ENV } from '../config/tokens';
import { createDataSource } from './data-source';

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      inject: [ENV],
      useFactory: async (env: Env) => {
        const log = new Logger('Database');
        const ds = createDataSource(env.DATABASE_URL, { poolSize: env.DB_POOL_SIZE });
        await ds.initialize();
        if (env.MIGRATE_ON_BOOT) {
          // Session-level advisory lock: when several replicas start together, one migrates and
          // the others wait, then find the schema up to date.
          const lock = ds.createQueryRunner();
          await lock.connect();
          try {
            await lock.query(`SELECT pg_advisory_lock(hashtext('ronin:migrations'))`);
            const ran = await ds.runMigrations();
            log.log(ran.length ? `applied migrations: ${ran.map((m) => m.name).join(', ')}` : 'schema up to date');
          } finally {
            await lock.query(`SELECT pg_advisory_unlock(hashtext('ronin:migrations'))`).catch(() => undefined);
            await lock.release();
          }
        }
        return ds;
      },
    },
  ],
  exports: [DATA_SOURCE],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}
  async onApplicationShutdown(): Promise<void> {
    await this.ds.destroy();
  }
}
