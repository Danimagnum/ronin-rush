import { Module } from '@nestjs/common';
import { ClockModule } from './clock/clock.module';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { RedisModule } from './redis/redis.module';
import { RoundModule } from './round/round.module';

@Module({
  imports: [ConfigModule, RedisModule, ClockModule, RoundModule],
  controllers: [HealthController],
})
export class AppModule {}
