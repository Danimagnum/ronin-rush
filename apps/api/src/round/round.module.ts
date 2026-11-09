import { Module } from '@nestjs/common';
import { EventHub } from './event-hub';
import { RoundRunner } from './round-runner.service';

@Module({
  providers: [RoundRunner, EventHub],
  exports: [RoundRunner, EventHub],
})
export class RoundModule {}
