import type { RoundEvent } from '@ronin/shared';
import type { QueryRunner } from 'typeorm';

/** Kafka topics (versioned). Internal-only events (e.g. bets.lost) have no topic. */
export const TOPICS = {
  roundStarted: 'ronin.round.started.v1',
  betPlaced: 'ronin.bet.placed.v1',
  betCashedOut: 'ronin.bet.cashed_out.v1',
  roundCrashed: 'ronin.round.crashed.v1',
  roundSettled: 'ronin.round.settled.v1',
} as const;

const TOPIC_BY_EVENT: Partial<Record<RoundEvent['type'], string>> = {
  'round.started': TOPICS.roundStarted,
  'round.crashed': TOPICS.roundCrashed,
  'round.settled': TOPICS.roundSettled,
  'bet.placed': TOPICS.betPlaced,
  'bet.cashed_out': TOPICS.betCashedOut,
};

export async function appendOutbox(q: QueryRunner, topic: string, key: string | number, payload: unknown): Promise<void> {
  await q.query(`INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)`, [topic, String(key), JSON.stringify(payload)]);
}

export async function appendRoundEvents(q: QueryRunner, events: RoundEvent[]): Promise<void> {
  for (const e of events) {
    const topic = TOPIC_BY_EVENT[e.type];
    if (!topic) continue;
    const key = 'roundId' in e ? e.roundId : e.bet.roundId;
    await appendOutbox(q, topic, key, e);
  }
}
