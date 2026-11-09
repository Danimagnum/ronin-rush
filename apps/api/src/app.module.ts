import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ClockModule } from './clock/clock.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { GameServicesModule } from './game-services.module';
import { HealthController } from './health/health.controller';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { RoundModule } from './round/round.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
    DbModule,
    ClockModule,
    WalletModule,
    RoundModule,
    AuthModule,
    RealtimeModule,
    GameServicesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
