import { Module } from '@nestjs/common';
import { RoundController } from './round.controller';
import { RoundRunner } from './round-runner.service';

@Module({
  controllers: [RoundController],
  providers: [RoundRunner],
  exports: [RoundRunner],
})
export class RoundModule {}
