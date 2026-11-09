import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RoundModule } from '../round/round.module';
import { ReadModel } from './read-model.service';
import { RealtimeGateway } from './realtime.gateway';
import { RoundController } from './round.controller';
import { SystemController, SystemMetricsService } from './system-metrics.service';
import { GameServicesModule } from '../game-services.module';

@Module({
  imports: [AuthModule, RoundModule, GameServicesModule],
  controllers: [RoundController, SystemController],
  providers: [ReadModel, RealtimeGateway, SystemMetricsService],
  exports: [ReadModel, RealtimeGateway],
})
export class RealtimeModule {}
