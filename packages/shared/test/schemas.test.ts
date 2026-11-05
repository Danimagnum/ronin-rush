import { describe, expect, it } from 'vitest';
import { CashoutCommand, PlaceBetCommand, RoundEvent } from '../src/index.js';

describe('wire schemas', () => {
  it('validates bet commands and rejects bad amounts / auto cash-outs', () => {
    expect(PlaceBetCommand.safeParse({ amount: 1000, autoX100: 200, idempotencyKey: 'abcdefgh' }).success).toBe(true);
    expect(PlaceBetCommand.safeParse({ amount: 1000, idempotencyKey: 'abcdefgh' }).success).toBe(true);
    expect(PlaceBetCommand.safeParse({ amount: 1.5, idempotencyKey: 'abcdefgh' }).success).toBe(false);
    expect(PlaceBetCommand.safeParse({ amount: 1000, autoX100: 100, idempotencyKey: 'abcdefgh' }).success).toBe(false);
    expect(PlaceBetCommand.safeParse({ amount: 1000, idempotencyKey: 'short' }).success).toBe(false);
  });

  it('cash-out commands carry no multiplier: the server decides it', () => {
    const parsed = CashoutCommand.parse({ roundId: 7, idempotencyKey: 'abcdefgh', x100: 99_999 });
    expect(parsed).not.toHaveProperty('x100');
  });

  it('discriminates round events by type', () => {
    const e = RoundEvent.parse({ type: 'round.started', roundId: 1, startedAt: 1, k: 0.00006 });
    expect(e.type).toBe('round.started');
  });
});
