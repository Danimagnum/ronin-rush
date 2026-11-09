import { Module } from '@nestjs/common';
import { DevController } from './dev.controller';
import { RoundController } from './round.controller';
import { RoundRunner } from './round-runner.service';

@Module({
  controllers: [RoundController, DevController],
  providers: [RoundRunner],
  exports: [RoundRunner],
})
export class RoundModule {}
