import { describe, expect, it } from 'vitest';
import { toConsumedEntry } from '../src/events/kafka-tap-consumer.service';

describe('Kafka tap consumer mapping', () => {
  it('reports topic, partition, offset and the delay since the outbox row was written', () => {
    const occurredAt = '2026-11-10T10:00:00.000Z';
    const value = Buffer.from(JSON.stringify({ eventId: 'outbox-42', occurredAt, payload: {} }));
    const now = Date.parse(occurredAt) + 37;
    const e = toConsumedEntry('ronin.bet.placed.v1', 2, { offset: '1088', key: Buffer.from('17'), value, timestamp: String(now - 5) }, now);
    expect(e).toEqual({
      topic: 'ronin.bet.placed.v1',
      partition: 2,
      offset: '1088',
      key: '17',
      eventId: 'outbox-42',
      endToEndMs: 37,
      consumedAt: new Date(now).toISOString(),
    });
  });

  it('falls back to the record timestamp for messages that are not ours', () => {
    const now = 1_000_000;
    const e = toConsumedEntry('ronin.round.started.v1', 0, { offset: '5', key: null, value: Buffer.from('not json'), timestamp: String(now - 12) }, now);
    expect(e.eventId).toBe('');
    expect(e.key).toBe('');
    expect(e.endToEndMs).toBe(12);
  });
});
