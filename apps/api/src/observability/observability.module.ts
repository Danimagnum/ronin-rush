import { Module } from '@nestjs/common';
import { GameServicesModule } from '../game-services.module';
import { HealthController, MetricsController } from '../health/health.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoundModule } from '../round/round.module';
import { HealthService } from './health.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsService } from './metrics.service';
import { HttpMetrics } from './prometheus';

@Module({
  imports: [RoundModule, GameServicesModule, RealtimeModule],
  controllers: [HealthController, MetricsController],
  providers: [{ provide: HttpMetrics, useValue: new HttpMetrics() }, HttpMetricsMiddleware, HealthService, MetricsService],
  exports: [HttpMetrics, HttpMetricsMiddleware, HealthService],
})
export class ObservabilityModule {}
