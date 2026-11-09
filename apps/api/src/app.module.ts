import { Module } from '@nestjs/common';
import { ClockModule } from './clock/clock.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { RedisModule } from './redis/redis.module';
import { RoundModule } from './round/round.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [ConfigModule, RedisModule, DbModule, ClockModule, WalletModule, RoundModule],
  controllers: [HealthController],
})
export class AppModule {}
