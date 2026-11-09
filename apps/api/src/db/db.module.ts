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
          const ran = await ds.runMigrations();
          log.log(ran.length ? `applied migrations: ${ran.map((m) => m.name).join(', ')}` : 'schema up to date');
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
