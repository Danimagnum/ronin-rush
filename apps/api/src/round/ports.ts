import type { RoundEvent } from '@ronin/shared';

/**
 * Ports the round engine depends on. The engine is pure orchestration; storage, money and
 * fan-out are plugged in (in-memory for tests, Postgres/Redis/Kafka in production).
 */

export interface RoundSeed {
  roundId: number;
  /** Server seed for this round (index roundId in the hash chain). Secret until settlement. */
  seed: string;
}

export interface SeedSource {
  next(): Promise<RoundSeed>;
  readonly commitment: string;
}

export interface StakeDebit {
  betId: string;
  userId: string;
  roundId: number;
  amount: number;
  idempotencyKey: string;
}

export interface CashoutCredit {
  betId: string;
  userId: string;
  roundId: number;
  stake: number;
  payout: number;
  idempotencyKey: string;
}

export interface LostStake {
  betId: string;
  userId: string;
  amount: number;
}

export type DebitResult = { ok: true } | { ok: false; reason: 'INSUFFICIENT_FUNDS' };

/** Double-entry wallet operations. Every call is idempotent on its idempotencyKey. */
export interface BetLedger {
  debitStake(op: StakeDebit): Promise<DebitResult>;
  creditCashout(op: CashoutCredit): Promise<void>;
  settleLosses(roundId: number, lost: LostStake[], idempotencyKey: string): Promise<void>;
}

/**
 * Resolves once every relay instance has forwarded all commands it received before `crashedAt`
 * (or the timeout elapses). Prevents settling a round while a legitimate pre-crash cash-out
 * is still in flight between an edge instance and the leader.
 */
export interface DrainBarrier {
  waitUntilDrained(crashedAt: number, timeoutMs: number): Promise<void>;
}

export interface RoundEventSink {
  emit(event: RoundEvent): void;
}
