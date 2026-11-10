import { z } from 'zod';

/**
 * Contract between the round engine, the real-time gateway and the browser.
 * Money is integer cents; multipliers are integer x100; timestamps are server epoch ms.
 */

export const GAME_DEFAULTS = {
  bettingMs: 8_000,
  resultMs: 3_000,
  /** Upper bound on waiting for relay instances to flush cash-outs received before the crash. */
  drainTimeoutMs: 1_000,
  minBetCents: 10,
  maxBetCents: 1_000_000,
  minAutoX100: 101,
  maxAutoX100: 1_000_000,
} as const;

export const RoundPhase = z.enum(['BETTING', 'RUNNING', 'CRASHED', 'SETTLED']);
export type RoundPhase = z.infer<typeof RoundPhase>;

export const BetStatus = z.enum(['ACTIVE', 'CASHED_OUT', 'LOST']);
export type BetStatus = z.infer<typeof BetStatus>;

const cents = z.number().int().nonnegative();
const x100 = z.number().int().min(100);
const epochMs = z.number().nonnegative();
const seedHex = z.string().regex(/^[0-9a-f]{64}$/);

export const PublicBet = z.object({
  betId: z.string(),
  roundId: z.number().int().positive(),
  userId: z.string(),
  username: z.string(),
  isBot: z.boolean(),
  amount: cents,
  autoX100: x100.nullable(),
  status: BetStatus,
  cashoutX100: x100.nullable(),
  payout: cents.nullable(),
});
export type PublicBet = z.infer<typeof PublicBet>;

// ── server -> client events ────────────────────────────────────────────────

export const RoundBettingEvent = z.object({
  type: z.literal('round.betting'),
  roundId: z.number().int().positive(),
  /** SHA256(seed) of this round: committed now, preimage revealed at settlement. */
  seedHash: seedHex,
  bettingEndsAt: epochMs,
  serverTime: epochMs,
});

export const RoundStartedEvent = z.object({
  type: z.literal('round.started'),
  roundId: z.number().int().positive(),
  startedAt: epochMs,
  k: z.number().positive(),
});

export const RoundCrashedEvent = z.object({
  type: z.literal('round.crashed'),
  roundId: z.number().int().positive(),
  crashX100: x100,
  crashedAt: epochMs,
});

export const RoundSettledEvent = z.object({
  type: z.literal('round.settled'),
  roundId: z.number().int().positive(),
  crashX100: x100,
  seed: seedHex,
  settledAt: epochMs,
  nextRoundAt: epochMs,
});

export const BetPlacedEvent = z.object({ type: z.literal('bet.placed'), bet: PublicBet });
export const BetCashedOutEvent = z.object({
  type: z.literal('bet.cashed_out'),
  bet: PublicBet,
  auto: z.boolean(),
});
export const BetsLostEvent = z.object({
  type: z.literal('bets.lost'),
  roundId: z.number().int().positive(),
  betIds: z.array(z.string()),
});

export const RoundEvent = z.discriminatedUnion('type', [
  RoundBettingEvent,
  RoundStartedEvent,
  RoundCrashedEvent,
  RoundSettledEvent,
  BetPlacedEvent,
  BetCashedOutEvent,
  BetsLostEvent,
]);
export type RoundEvent = z.infer<typeof RoundEvent>;
export type RoundEventOf<T extends RoundEvent['type']> = Extract<RoundEvent, { type: T }>;

/** Everything a client that joins mid-round needs to render the current state. */
export const RoundSnapshot = z.object({
  roundId: z.number().int().positive(),
  phase: RoundPhase,
  seedHash: seedHex,
  bettingEndsAt: epochMs,
  startedAt: epochMs.nullable(),
  /** Only present once the round has crashed. */
  crashX100: x100.nullable(),
  crashedAt: epochMs.nullable(),
  k: z.number().positive(),
  bets: z.array(PublicBet),
  serverTime: epochMs,
});
export type RoundSnapshot = z.infer<typeof RoundSnapshot>;

// ── client -> server commands ──────────────────────────────────────────────

const idempotencyKey = z.string().min(8).max(64);

export const PlaceBetCommand = z.object({
  amount: z.number().int().min(GAME_DEFAULTS.minBetCents).max(GAME_DEFAULTS.maxBetCents),
  autoX100: z.number().int().min(GAME_DEFAULTS.minAutoX100).max(GAME_DEFAULTS.maxAutoX100).nullable().optional(),
  idempotencyKey,
});
export type PlaceBetCommand = z.infer<typeof PlaceBetCommand>;

export const CashoutCommand = z.object({
  roundId: z.number().int().positive(),
  idempotencyKey,
});
export type CashoutCommand = z.infer<typeof CashoutCommand>;

export const TimePing = z.object({ c0: z.number() });
export const TimePong = z.object({ c0: z.number(), s1: epochMs, s2: epochMs });
export type TimePong = z.infer<typeof TimePong>;

export const CommandError = z.enum([
  'VALIDATION_ERROR',
  'BETTING_CLOSED',
  'ALREADY_BET',
  'INSUFFICIENT_FUNDS',
  /** PLATFORM_MODE: platform-core refused the stake (limits, exclusion, KYC). */
  'RESPONSIBLE_GAMING_BLOCKED',
  /** PLATFORM_MODE: the platform wallet could not be reached; nothing was charged. */
  'WALLET_UNAVAILABLE',
  'NO_ACTIVE_BET',
  'NOT_RUNNING',
  'CASHOUT_AFTER_CRASH',
  'ROUND_MISMATCH',
  'NOT_LEADER',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'TIMEOUT',
]);
export type CommandError = z.infer<typeof CommandError>;

// ── socket contract ────────────────────────────────────────────────────────

export const SOCKET_EVENTS = {
  /** server -> client, once on connect */
  hello: 'hello',
  /** server -> client broadcast: a phase change (sent immediately) */
  roundEvent: 'round:event',
  /** server -> client broadcast: bets and cash-outs, batched every ~100 ms (RoundEvent[]) */
  roundBatch: 'round:batch',
  /** server -> client (own room): wallet balance after a money movement */
  balance: 'balance',
  /** server -> client (room "system"): live metrics for the System view */
  systemMetrics: 'system:metrics',
  /** client -> server, with ack */
  timePing: 'time:ping',
  placeBet: 'bet:place',
  cashout: 'bet:cashout',
  /** client -> server: join/leave the System view metrics room */
  systemSubscribe: 'system:subscribe',
} as const;

export const SettledRoundSummary = z.object({
  roundId: z.number().int().positive(),
  crashX100: x100,
  seed: seedHex,
  seedHash: seedHex,
  settledAt: epochMs,
});
export type SettledRoundSummary = z.infer<typeof SettledRoundSummary>;

export const SessionUser = z.object({ id: z.string(), username: z.string(), balance: cents });
export type SessionUser = z.infer<typeof SessionUser>;

export const ServerHello = z.object({
  instanceId: z.string(),
  serverTime: epochMs,
  snapshot: RoundSnapshot.nullable(),
  history: z.array(SettledRoundSummary),
  user: SessionUser.nullable(),
  fairness: z.object({ commitment: seedHex, publicSalt: z.string() }),
});
export type ServerHello = z.infer<typeof ServerHello>;

export type CommandAck<T> = { ok: true } & T | { ok: false; error: CommandError };
