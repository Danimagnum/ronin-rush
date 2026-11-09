import type { PublicBet, RoundEvent, RoundPhase } from '@ronin/shared';

/**
 * Ports the round engine depends on. The engine is pure orchestration; storage, money and
 * fan-out are plugged in (in-memory for tests, Postgres/Redis/Kafka in production).
 */

export interface SeedSource {
  /** Public commitment C = SHA256(seed_1). */
  readonly commitment: string;
  /** Secret server seed of round `roundId` (= its index in the hash chain). */
  seedFor(roundId: number): Promise<string>;
}

/** Thrown when a write is attempted with a fencing token older than the current leader's. */
export class FencedOutError extends Error {
  constructor(token: number) {
    super(`fenced out: token ${token} is no longer the leader's`);
    this.name = 'FencedOutError';
  }
}

export interface StakeDebit {
  betId: string;
  userId: string;
  roundId: number;
  amount: number;
  autoX100: number | null;
  clientKey: string;
  placedAt: number;
  idempotencyKey: string;
  fencingToken: number;
}

export interface CashoutCredit {
  betId: string;
  userId: string;
  roundId: number;
  stake: number;
  payout: number;
  x100: number;
  auto: boolean;
  cashedAt: number;
  idempotencyKey: string;
  fencingToken: number;
}

export interface LostStake {
  betId: string;
  userId: string;
  amount: number;
}

export type DebitResult = { ok: true; balance: number | null } | { ok: false; reason: 'INSUFFICIENT_FUNDS' };

/**
 * Double-entry wallet operations. Every call is idempotent on its idempotencyKey and commits
 * the money movement together with the bet's state change and its outbox event.
 */
export interface BetLedger {
  debitStake(op: StakeDebit): Promise<DebitResult>;
  creditCashout(op: CashoutCredit): Promise<void>;
  settleLosses(roundId: number, lost: LostStake[], idempotencyKey: string, fencingToken: number): Promise<void>;
}

export interface PersistedRound {
  id: number;
  seedHash: string;
  crashX100: number;
  phase: RoundPhase;
  bettingEndsAt: number;
  startedAt: number | null;
  crashAt: number | null;
  crashedAt: number | null;
  settledAt: number | null;
  /** Revealed only once SETTLED. */
  seed: string | null;
}

export interface PersistedBet extends PublicBet {
  clientKey: string;
  placedAt: number;
  cashedAt: number | null;
}

export interface SettledRound {
  roundId: number;
  crashX100: number;
  seed: string;
  seedHash: string;
  settledAt: number;
}

/** Durable round state so a new leader resumes the exact same round after a failover. */
export interface RoundStore {
  /** Upserts the round and appends `events` to the outbox atomically; throws FencedOutError. */
  save(round: PersistedRound, fencingToken: number, events: RoundEvent[]): Promise<void>;
  latest(): Promise<PersistedRound | null>;
  bets(roundId: number): Promise<PersistedBet[]>;
  recent(limit: number): Promise<SettledRound[]>;
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
