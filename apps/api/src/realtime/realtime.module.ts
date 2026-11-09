import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RoundModule } from '../round/round.module';
import { ReadModel } from './read-model.service';
import { RealtimeGateway } from './realtime.gateway';
import { RoundController } from './round.controller';

@Module({
  imports: [AuthModule, RoundModule],
  controllers: [RoundController],
  providers: [ReadModel, RealtimeGateway],
  exports: [ReadModel, RealtimeGateway],
})
export class RealtimeModule {}
