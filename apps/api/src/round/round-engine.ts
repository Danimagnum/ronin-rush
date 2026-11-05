import { randomUUID } from 'node:crypto';
import {
  GAME_DEFAULTS,
  autoCashoutWins,
  crashPointX100,
  decideCashout,
  elapsedMsForX100,
  payoutFor,
  sha256Hex,
  type CommandError,
  type PublicBet,
  type RoundEvent,
  type RoundPhase,
  type RoundSnapshot,
} from '@ronin/shared';
import type { Clock } from '../clock/clock';
import type { BetLedger, DrainBarrier, RoundEventSink, SeedSource } from './ports';
import { SerialQueue } from './serial-queue';

export interface RoundEngineConfig {
  bettingMs: number;
  resultMs: number;
  drainTimeoutMs: number;
  /** Growth rate of m(t) = e^(k·t), per millisecond. */
  k: number;
  publicSalt: string;
  minBetCents: number;
  maxBetCents: number;
}

export interface RoundEngineDeps {
  clock: Clock;
  seeds: SeedSource;
  ledger: BetLedger;
  drain: DrainBarrier;
  events: RoundEventSink;
  config: RoundEngineConfig;
  onError?: (err: unknown) => void;
}

export interface PlaceBetInput {
  userId: string;
  username: string;
  isBot?: boolean;
  amount: number;
  autoX100?: number | null;
  idempotencyKey: string;
  /** Server timestamp captured when the command arrived at the edge. */
  receivedAt: number;
}

export interface CashoutInput {
  userId: string;
  roundId: number;
  idempotencyKey: string;
  receivedAt: number;
}

export type BetResult = { ok: true; bet: PublicBet } | { ok: false; error: CommandError };

export interface SettledRound {
  roundId: number;
  crashX100: number;
  seed: string;
  seedHash: string;
  settledAt: number;
}

interface BetState extends PublicBet {
  placedAt: number;
  cashedAt: number | null;
}

interface RoundState {
  id: number;
  seed: string;
  seedHash: string;
  crashX100: number;
  phase: RoundPhase;
  bettingEndsAt: number;
  startedAt: number | null;
  /** Precomputed crash instant; never leaves the leader before it happens. */
  crashAt: number | null;
  crashedAt: number | null;
  settledAt: number | null;
  bets: Map<string, BetState>; // by userId
  betKeys: Map<string, string>; // idempotencyKey -> userId
}

const HISTORY_SIZE = 50;
const LATENCY_WINDOW = 200;

/**
 * Leader-only round loop:
 *
 *   BETTING ──(bettingEndsAt)──▶ RUNNING ──(crashAt)──▶ CRASHED ──(drained)──▶ SETTLED ──(+resultMs)──▶ BETTING …
 *
 * Phase boundaries are *nominal* instants computed up front (startedAt = bettingEndsAt,
 * crashedAt = crashAt). Timers only trigger the transitions; how late a timer fires is
 * measured as "round loop latency" but never changes who wins: every decision compares a
 * command's receive timestamp with those nominal instants.
 */
export class RoundEngine {
  private readonly queue = new SerialQueue();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly latencies: number[] = [];
  private readonly history: SettledRound[] = [];
  private round: RoundState | null = null;
  private running = false;

  constructor(private readonly deps: RoundEngineDeps) {}

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.queue.run(() => this.openBetting()).catch((e) => this.fail(e));
  }

  /** Stops scheduling. A new leader resumes from persisted state (see RoundStore, wallet milestone). */
  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── commands ─────────────────────────────────────────────────────────────

  placeBet(input: PlaceBetInput): Promise<BetResult> {
    return this.queue.run(() => this.handlePlaceBet(input));
  }

  cashOut(input: CashoutInput): Promise<BetResult> {
    return this.queue.run(() => this.handleCashout(input));
  }

  // ── read model ───────────────────────────────────────────────────────────

  snapshot(): RoundSnapshot | null {
    const r = this.round;
    if (!r) return null;
    const crashed = r.phase === 'CRASHED' || r.phase === 'SETTLED';
    return {
      roundId: r.id,
      phase: r.phase,
      seedHash: r.seedHash,
      bettingEndsAt: r.bettingEndsAt,
      startedAt: r.startedAt,
      crashX100: crashed ? r.crashX100 : null,
      crashedAt: r.crashedAt,
      k: this.deps.config.k,
      bets: [...r.bets.values()].map(toPublic),
      serverTime: this.deps.clock.now(),
    };
  }

  recentRounds(): readonly SettledRound[] {
    return this.history;
  }

  metrics() {
    const l = this.latencies;
    const sorted = [...l].sort((a, b) => a - b);
    return {
      loopLatencyMs: {
        last: l.at(-1) ?? 0,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
        max: sorted.at(-1) ?? 0,
      },
      queueDepth: this.queue.size,
      roundsSettled: this.history.length,
    };
  }

  // ── transitions ──────────────────────────────────────────────────────────

  private async openBetting(): Promise<void> {
    if (!this.running) return;
    const { config, clock, seeds } = this.deps;
    const { roundId, seed } = await seeds.next();
    const now = clock.now();
    this.round = {
      id: roundId,
      seed,
      seedHash: sha256Hex(seed),
      crashX100: crashPointX100(seed, config.publicSalt),
      phase: 'BETTING',
      bettingEndsAt: now + config.bettingMs,
      startedAt: null,
      crashAt: null,
      crashedAt: null,
      settledAt: null,
      bets: new Map(),
      betKeys: new Map(),
    };
    this.emit({
      type: 'round.betting',
      roundId,
      seedHash: this.round.seedHash,
      bettingEndsAt: this.round.bettingEndsAt,
      serverTime: now,
    });
    this.schedule('start', this.round.bettingEndsAt, () => this.startRunning());
  }

  private async startRunning(): Promise<void> {
    const r = this.round!;
    const { k } = this.deps.config;
    r.phase = 'RUNNING';
    r.startedAt = r.bettingEndsAt;
    r.crashAt = r.startedAt + elapsedMsForX100(r.crashX100, k);
    this.emit({ type: 'round.started', roundId: r.id, startedAt: r.startedAt, k });
    if (r.crashX100 === 100) {
      await this.crash(); // instant bust: no timer needed
      return;
    }
    this.scheduleNextAuto();
    this.schedule('crash', r.crashAt, () => this.crash());
  }

  private scheduleNextAuto(): void {
    const r = this.round!;
    const next = this.pendingAutos()[0];
    if (!next) return;
    const at = r.startedAt! + elapsedMsForX100(next.autoX100!, this.deps.config.k);
    this.schedule('auto', at, () => this.runDueAutos());
  }

  /** Winning auto cash-outs, ordered by target multiplier. */
  private pendingAutos(): BetState[] {
    const r = this.round!;
    return [...r.bets.values()]
      .filter((b) => b.status === 'ACTIVE' && b.autoX100 !== null && autoCashoutWins(b.autoX100, r.crashX100))
      .sort((a, b) => a.autoX100! - b.autoX100!);
  }

  private async runDueAutos(): Promise<void> {
    const r = this.round!;
    if (r.phase !== 'RUNNING') return;
    const elapsed = this.deps.clock.now() - r.startedAt!;
    for (const bet of this.pendingAutos()) {
      const dueAfter = elapsedMsForX100(bet.autoX100!, this.deps.config.k);
      if (dueAfter > elapsed + 1) break; // 1 ms tolerance for timer/clock granularity
      await this.settleCashout(bet, bet.autoX100!, true, r.startedAt! + dueAfter);
    }
    this.scheduleNextAuto();
  }

  private async crash(): Promise<void> {
    const r = this.round!;
    this.clearTimer('auto');
    // A late auto timer must not cost the player: any auto target below the crash point was
    // reached before the crash instant, so it is paid even if its timer had not fired yet.
    for (const bet of this.pendingAutos()) {
      await this.settleCashout(bet, bet.autoX100!, true, r.startedAt! + elapsedMsForX100(bet.autoX100!, this.deps.config.k));
    }
    r.phase = 'CRASHED';
    r.crashedAt = r.crashAt!;
    this.emit({ type: 'round.crashed', roundId: r.id, crashX100: r.crashX100, crashedAt: r.crashedAt });

    // Wait outside the queue so in-flight cash-outs (received before crashAt) can still be applied.
    const roundId = r.id;
    void this.deps.drain
      .waitUntilDrained(r.crashedAt, this.deps.config.drainTimeoutMs)
      .catch(() => undefined)
      .then(() => this.queue.run(() => this.settle(roundId)))
      .catch((e) => this.fail(e));
  }

  private async settle(roundId: number): Promise<void> {
    const r = this.round;
    if (!r || r.id !== roundId || r.phase !== 'CRASHED') return;
    const lost = [...r.bets.values()].filter((b) => b.status === 'ACTIVE');
    await this.deps.ledger.settleLosses(
      r.id,
      lost.map((b) => ({ betId: b.betId, userId: b.userId, amount: b.amount })),
      `round-loss:${r.id}`,
    );
    for (const b of lost) {
      b.status = 'LOST';
      b.payout = 0;
    }
    if (lost.length) this.emit({ type: 'bets.lost', roundId: r.id, betIds: lost.map((b) => b.betId) });

    r.phase = 'SETTLED';
    r.settledAt = this.deps.clock.now();
    const nextRoundAt = Math.max(r.crashedAt! + this.deps.config.resultMs, r.settledAt);
    this.history.unshift({ roundId: r.id, crashX100: r.crashX100, seed: r.seed, seedHash: r.seedHash, settledAt: r.settledAt });
    if (this.history.length > HISTORY_SIZE) this.history.pop();
    this.emit({
      type: 'round.settled',
      roundId: r.id,
      crashX100: r.crashX100,
      seed: r.seed,
      settledAt: r.settledAt,
      nextRoundAt,
    });
    this.schedule('next', nextRoundAt, () => this.openBetting());
  }

  // ── command handlers (run inside the serial queue) ───────────────────────

  private async handlePlaceBet(input: PlaceBetInput): Promise<BetResult> {
    const r = this.round;
    if (!this.running || !r || r.phase !== 'BETTING' || input.receivedAt >= r.bettingEndsAt) {
      return { ok: false, error: 'BETTING_CLOSED' };
    }
    const existingByKey = r.betKeys.get(input.idempotencyKey);
    if (existingByKey !== undefined) {
      return existingByKey === input.userId
        ? { ok: true, bet: toPublic(r.bets.get(input.userId)!) }
        : { ok: false, error: 'VALIDATION_ERROR' };
    }
    if (r.bets.has(input.userId)) return { ok: false, error: 'ALREADY_BET' };

    const { minBetCents, maxBetCents } = this.deps.config;
    const auto = input.autoX100 ?? null;
    if (
      !Number.isInteger(input.amount) ||
      input.amount < minBetCents ||
      input.amount > maxBetCents ||
      (auto !== null && (!Number.isInteger(auto) || auto < GAME_DEFAULTS.minAutoX100))
    ) {
      return { ok: false, error: 'VALIDATION_ERROR' };
    }

    const betId = randomUUID();
    const debit = await this.deps.ledger.debitStake({
      betId,
      userId: input.userId,
      roundId: r.id,
      amount: input.amount,
      idempotencyKey: `bet:${r.id}:${input.userId}`,
    });
    if (!debit.ok) return { ok: false, error: debit.reason };

    const bet: BetState = {
      betId,
      roundId: r.id,
      userId: input.userId,
      username: input.username,
      isBot: input.isBot ?? false,
      amount: input.amount,
      autoX100: auto,
      status: 'ACTIVE',
      cashoutX100: null,
      payout: null,
      placedAt: input.receivedAt,
      cashedAt: null,
    };
    r.bets.set(input.userId, bet);
    r.betKeys.set(input.idempotencyKey, input.userId);
    this.emit({ type: 'bet.placed', bet: toPublic(bet) });
    return { ok: true, bet: toPublic(bet) };
  }

  private async handleCashout(input: CashoutInput): Promise<BetResult> {
    const r = this.round;
    if (!r || r.id !== input.roundId) return { ok: false, error: 'ROUND_MISMATCH' };
    const bet = r.bets.get(input.userId);
    if (!bet) return { ok: false, error: 'NO_ACTIVE_BET' };
    if (bet.status === 'CASHED_OUT') return { ok: true, bet: toPublic(bet) }; // idempotent retry
    if (bet.status === 'LOST' || r.phase === 'SETTLED') return { ok: false, error: 'CASHOUT_AFTER_CRASH' };
    if (r.phase === 'BETTING') return { ok: false, error: 'NOT_RUNNING' };

    const decision = decideCashout({
      receivedAt: input.receivedAt,
      startedAt: r.startedAt!,
      crashAt: r.crashAt!,
      crashX100: r.crashX100,
      k: this.deps.config.k,
    });
    if (!decision.ok) return { ok: false, error: decision.reason };

    // If the auto target was already passed when the click arrived, the auto fired first.
    if (bet.autoX100 !== null && autoCashoutWins(bet.autoX100, r.crashX100) && bet.autoX100 <= decision.x100) {
      await this.settleCashout(bet, bet.autoX100, true, r.startedAt! + elapsedMsForX100(bet.autoX100, this.deps.config.k));
    } else {
      await this.settleCashout(bet, decision.x100, false, input.receivedAt);
    }
    if (r.phase === 'RUNNING') this.scheduleNextAuto();
    return { ok: true, bet: toPublic(bet) };
  }

  private async settleCashout(bet: BetState, x100: number, auto: boolean, cashedAt: number): Promise<void> {
    const payout = payoutFor(bet.amount, x100);
    await this.deps.ledger.creditCashout({
      betId: bet.betId,
      userId: bet.userId,
      roundId: bet.roundId,
      stake: bet.amount,
      payout,
      idempotencyKey: `cashout:${bet.betId}`,
    });
    bet.status = 'CASHED_OUT';
    bet.cashoutX100 = x100;
    bet.payout = payout;
    bet.cashedAt = cashedAt;
    this.emit({ type: 'bet.cashed_out', bet: toPublic(bet), auto });
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private schedule(name: string, at: number, fn: () => Promise<void>): void {
    this.clearTimer(name);
    if (!this.running) return;
    const delay = Math.max(0, at - this.deps.clock.now());
    const handle = setTimeout(() => {
      this.timers.delete(name);
      this.recordLatency(this.deps.clock.now() - at);
      void this.queue.run(fn).catch((e) => this.fail(e));
    }, delay);
    this.timers.set(name, handle);
  }

  private clearTimer(name: string): void {
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    this.timers.delete(name);
  }

  private recordLatency(ms: number): void {
    this.latencies.push(Math.max(0, ms));
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  private emit(event: RoundEvent): void {
    try {
      this.deps.events.emit(event);
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(err: unknown): void {
    (this.deps.onError ?? ((e) => console.error('[round-engine]', e)))(err);
  }
}

function toPublic(b: BetState): PublicBet {
  return {
    betId: b.betId,
    roundId: b.roundId,
    userId: b.userId,
    username: b.username,
    isBot: b.isBot,
    amount: b.amount,
    autoX100: b.autoX100,
    status: b.status,
    cashoutX100: b.cashoutX100,
    payout: b.payout,
  };
}
