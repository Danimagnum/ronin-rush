import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, type Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type * as SentrySetup from '@sentry/nestjs/setup';
import { AuthModule } from './auth/auth.module';
import { ClockModule } from './clock/clock.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { GameServicesModule } from './game-services.module';
import { Sentry } from './instrument';
import { HttpMetricsMiddleware } from './observability/http-metrics.middleware';
import { ObservabilityModule } from './observability/observability.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { RoundModule } from './round/round.module';
import { WalletModule } from './wallet/wallet.module';

// The Sentry Nest integration is only loaded with a DSN (see instrument.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sentry = Sentry.enabled ? (require('@sentry/nestjs/setup') as typeof SentrySetup) : null;
const sentryImports: DynamicModule[] = sentry ? [sentry.SentryModule.forRoot()] : [];
// Reports unhandled exceptions to Sentry, then lets Nest respond as usual.
const sentryProviders: Provider[] = sentry ? [{ provide: APP_FILTER, useClass: sentry.SentryGlobalFilter }] : [];

@Module({
  imports: [
    ...sentryImports,
    ConfigModule,
    RedisModule,
    DbModule,
    ClockModule,
    WalletModule,
    RoundModule,
    AuthModule,
    RealtimeModule,
    GameServicesModule,
    ObservabilityModule,
  ],
  providers: sentryProviders,
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
