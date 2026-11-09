import { Module } from '@nestjs/common';
import { BotsService } from './bots/bots.service';
import { OutboxRelay } from './events/outbox-relay.service';
import { LeaderboardController, LeaderboardService } from './leaderboard/leaderboard.service';
import { RoundModule } from './round/round.module';

@Module({
  imports: [RoundModule],
  controllers: [LeaderboardController],
  providers: [BotsService, LeaderboardService, OutboxRelay],
  exports: [LeaderboardService, OutboxRelay],
})
export class GameServicesModule {}
