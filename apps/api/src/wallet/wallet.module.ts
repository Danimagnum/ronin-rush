import { Controller, Get, Global, Inject, Module } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../config/tokens';
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
  ],
  exports: [PostgresLedger],
})
export class WalletModule {}
