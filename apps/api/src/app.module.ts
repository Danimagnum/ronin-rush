import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
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
    SentryModule.forRoot(),
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
  // Reports unhandled exceptions to Sentry (no-op without SENTRY_DSN), then lets Nest respond as usual.
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}
