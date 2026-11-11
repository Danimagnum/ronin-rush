import { Controller, Get, Global, Inject, Logger, Module } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Env } from '../config/env';
import { DATA_SOURCE, ENV, PLATFORM_LEDGER } from '../config/tokens';
import { Sentry } from '../instrument';
import { CoreClient } from '../platform/core-client';
import { PlatformLedger } from '../platform/platform-ledger';
import { PostgresLedger } from './postgres-ledger';

@Controller('api/ledger')
class LedgerController {
  constructor(private readonly ledger: PostgresLedger) {}

  /** Live proof the books balance; feeds the System view. */
  @Get('audit')
  audit() {
    return this.ledger.audit();
  }
}

@Global()
@Module({
  controllers: [LedgerController],
  providers: [
    {
      provide: PostgresLedger,
      inject: [DATA_SOURCE],
      useFactory: async (ds: DataSource) => {
        const ledger = new PostgresLedger(ds);
        await ledger.init();
        return ledger;
      },
    },
    {
      // PLATFORM_MODE: players' money lives in platform-core; null otherwise.
      provide: PLATFORM_LEDGER,
      inject: [ENV, DATA_SOURCE, PostgresLedger],
      useFactory: (env: Env, ds: DataSource, local: PostgresLedger): PlatformLedger | null => {
        if (!env.PLATFORM_MODE) return null;
        const log = new Logger('PlatformLedger');
        const core = new CoreClient({
          baseUrl: env.CORE_URL!,
          tokenUrl: env.CORE_TOKEN_URL,
          clientId: env.CORE_CLIENT_ID!,
          clientSecret: env.CORE_CLIENT_SECRET!,
          currency: env.CORE_CURRENCY,
        });
        return new PlatformLedger(ds, local, core, {
          houseAccountId: env.CORE_HOUSE_ACCOUNT_ID!,
          onError: (e) => {
            log.warn((e as Error).message);
            Sentry.captureException(e, { tags: { component: 'platform-ledger' } });
          },
        });
      },
    },
  ],
  exports: [PostgresLedger, PLATFORM_LEDGER],
})
export class WalletModule {}
