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
import {
  FencedOutError,
  type BetLedger,
  type DrainBarrier,
  type PersistedBet,
  type PersistedRound,
  type RoundEventSink,
  type RoundStore,
  type SeedSource,
  type SettledRound,
} from './ports';
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
  store: RoundStore;
  drain: DrainBarrier;
  events: RoundEventSink;
  config: RoundEngineConfig;
  onError?: (err: unknown) => void;
  /** Called when a write was rejected because a newer leader exists; the engine has already stopped. */
  onFenced?: () => void;
  onResume?: (info: { roundId: number; phase: RoundPhase }) => void;
  /** A player's wallet balance changed (from the ledger's own RETURNING value: no extra query). */
  onBalance?: (userId: string, balance: number, isBot: boolean) => void;
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

export type BetResult = { ok: true; bet: PublicBet; balance?: number | null } | { ok: false; error: CommandError };

type BetState = PersistedBet & {
  /** Set while the cash-out's ledger write is in flight (decision already taken). */
  cashing?: Promise<BetResult>;
};

/** A command either answers straight away or hands back the in-flight ledger write to await. */
type Step = BetResult | { wait: Promise<BetResult> };

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
  betKeys: Map<string, string>; // client idempotencyKey -> userId
  /** Bets accepted (on time) whose stake debit is still being written. */
  pendingBets: Map<string, Promise<BetResult>>; // by userId
  /** Every ledger write in flight for this round; phase transitions wait for all of them. */
  inflight: Set<Promise<unknown>>;
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
 *
 * Every transition is persisted (with its outbox events) before it is broadcast, so a new
 * leader resumes the very same round — same id, crash point and bets — after a failover.
 */
export class RoundEngine {
  private readonly queue = new SerialQueue();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly latencies: number[] = [];
  private history: SettledRound[] = [];
  private round: RoundState | null = null;
  private running = false;
  private token = 0;

  constructor(private readonly deps: RoundEngineDeps) {}

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Starts (or resumes) the loop as leader holding `fencingToken`. */
  start(fencingToken: number): void {
    if (this.running) return;
    this.running = true;
    this.token = fencingToken;
    void this.queue.run(() => this.resume()).catch((e) => this.fail(e));
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Resolves once every queued command/transition has been processed (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.queue.run(() => undefined);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /**
   * Decisions are serialised (the queue), ledger writes are not: the queue task validates and
   * reserves the bet synchronously, then the debit runs concurrently with other commands. Under
   * load this turns "one Postgres transaction at a time" into a pipeline (see load/README).
   */
  async placeBet(input: PlaceBetInput): Promise<BetResult> {
    const step = await this.queue.run(() => this.guardStep(() => this.beginPlaceBet(input)));
    return 'wait' in step ? step.wait : step;
  }

  async cashOut(input: CashoutInput): Promise<BetResult> {
    const step = await this.queue.run(() => this.guardStep(() => this.beginCashout(input)));
    return 'wait' in step ? step.wait : step;
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
      roundsInHistory: this.history.length,
    };
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  private async resume(): Promise<void> {
    const { store, clock, config } = this.deps;
    this.history = await store.recent(HISTORY_SIZE);
    const last = await store.latest();
    if (!last) return this.openBetting(1);

    this.round = await this.hydrate(last);
    const r = this.round;
    // Claim the fence before anything else: from this write on, the previous leader's writes fail.
    await this.persist([]);
    this.deps.onResume?.({ roundId: r.id, phase: r.phase });

    switch (r.phase) {
      case 'SETTLED':
        this.schedule('next', Math.max(r.crashedAt! + config.resultMs, clock.now()), () => this.openBetting(r.id + 1));
        return;
      case 'BETTING':
        // Re-announce so clients resync, then continue the countdown (or start right away).
        this.emit({ type: 'round.betting', roundId: r.id, seedHash: r.seedHash, bettingEndsAt: r.bettingEndsAt, serverTime: clock.now() });
        this.schedule('start', r.bettingEndsAt, () => this.startRunning());
        return;
      case 'RUNNING':
        this.emit({ type: 'round.started', roundId: r.id, startedAt: r.startedAt!, k: config.k });
        if (r.crashAt! <= clock.now()) return this.crash();
        this.scheduleNextAuto();
        this.schedule('crash', r.crashAt!, () => this.crash());
        return;
      case 'CRASHED':
        this.emit({ type: 'round.crashed', roundId: r.id, crashX100: r.crashX100, crashedAt: r.crashedAt! });
        this.settleAfterDrain(r);
        return;
    }
  }

  private async hydrate(p: PersistedRound): Promise<RoundState> {
    const seed = await this.deps.seeds.seedFor(p.id);
    // The stored crash point must be the one the seed dictates: refuse to run on tampered state.
    if (sha256Hex(seed) !== p.seedHash || crashPointX100(seed, this.deps.config.publicSalt) !== p.crashX100) {
      throw new Error(`round ${p.id}: persisted state does not match the hash chain`);
    }
    const bets = await this.deps.store.bets(p.id);
    return {
      id: p.id,
      seed,
      seedHash: p.seedHash,
      crashX100: p.crashX100,
      phase: p.phase,
      bettingEndsAt: p.bettingEndsAt,
      startedAt: p.startedAt,
      crashAt: p.crashAt,
      crashedAt: p.crashedAt,
      settledAt: p.settledAt,
      bets: new Map(bets.map((b) => [b.userId, b])),
      betKeys: new Map(bets.map((b) => [b.clientKey, b.userId])),
      pendingBets: new Map(),
      inflight: new Set(),
    };
  }

  // ── transitions ──────────────────────────────────────────────────────────

  private async openBetting(roundId: number): Promise<void> {
    if (!this.running) return;
    const { config, clock, seeds } = this.deps;
    const seed = await seeds.seedFor(roundId);
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
      pendingBets: new Map(),
      inflight: new Set(),
    };
    await this.persist([
      { type: 'round.betting', roundId, seedHash: this.round.seedHash, bettingEndsAt: this.round.bettingEndsAt, serverTime: now },
    ]);
    this.schedule('start', this.round.bettingEndsAt, () => this.startRunning());
  }

  private async startRunning(): Promise<void> {
    const r = this.round!;
    // Bets accepted before bettingEndsAt may still be writing their debit: the field is final
    // only once they land.
    await this.drainInflight(r);
    const { k } = this.deps.config;
    r.phase = 'RUNNING';
    r.startedAt = r.bettingEndsAt;
    r.crashAt = r.startedAt + elapsedMsForX100(r.crashX100, k);
    await this.persist([{ type: 'round.started', roundId: r.id, startedAt: r.startedAt, k }]);
    if (r.crashAt <= this.deps.clock.now()) return this.crash(); // 1.00x, or resumed after the crash instant
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
      .filter((b) => b.status === 'ACTIVE' && !b.cashing && b.autoX100 !== null && autoCashoutWins(b.autoX100, r.crashX100))
      .sort((a, b) => a.autoX100! - b.autoX100!);
  }

  private async runDueAutos(): Promise<void> {
    const r = this.round!;
    if (r.phase !== 'RUNNING') return;
    const elapsed = this.deps.clock.now() - r.startedAt!;
    for (const bet of this.pendingAutos()) {
      const dueAfter = elapsedMsForX100(bet.autoX100!, this.deps.config.k);
      if (dueAfter > elapsed + 1) break; // 1 ms tolerance for timer/clock granularity
      this.startCashout(r, bet, bet.autoX100!, true, r.startedAt! + dueAfter);
    }
    this.scheduleNextAuto();
  }

  private async crash(): Promise<void> {
    const r = this.round!;
    if (r.phase !== 'RUNNING') return;
    this.clearTimer('auto');
    this.clearTimer('crash');
    // A late auto timer must not cost the player: any target below the crash point was reached
    // before the crash instant, so it is paid even if its timer had not fired yet.
    for (const bet of this.pendingAutos()) {
      this.startCashout(r, bet, bet.autoX100!, true, r.startedAt! + elapsedMsForX100(bet.autoX100!, this.deps.config.k));
    }
    // Persist CRASHED only once every winning cash-out is in the ledger: a new leader resuming
    // from CRASHED must never see a winner's bet still ACTIVE.
    await this.drainInflight(r);
    r.phase = 'CRASHED';
    r.crashedAt = r.crashAt!;
    await this.persist([{ type: 'round.crashed', roundId: r.id, crashX100: r.crashX100, crashedAt: r.crashedAt }]);
    this.settleAfterDrain(r);
  }

  /** Waits outside the queue so in-flight cash-outs received before crashAt can still be applied. */
  private settleAfterDrain(r: RoundState): void {
    const roundId = r.id;
    void this.deps.drain
      .waitUntilDrained(r.crashedAt!, this.deps.config.drainTimeoutMs)
      .catch(() => undefined)
      .then(() => this.queue.run(() => this.guard(() => this.settle(roundId))))
      .catch((e) => this.fail(e));
  }

  private async settle(roundId: number): Promise<void> {
    const r = this.round;
    if (!this.running || !r || r.id !== roundId || r.phase !== 'CRASHED') return;
    await this.drainInflight(r); // cash-outs accepted during the drain window
    const lost = [...r.bets.values()].filter((b) => b.status === 'ACTIVE');
    if (lost.length) {
      await this.deps.ledger.settleLosses(
        r.id,
        lost.map((b) => ({ betId: b.betId, userId: b.userId, amount: b.amount })),
        `round-loss:${r.id}`,
        this.token,
      );
    }
    for (const b of lost) {
      b.status = 'LOST';
      b.payout = 0;
    }

    r.phase = 'SETTLED';
    r.settledAt = this.deps.clock.now();
    const nextRoundAt = Math.max(r.crashedAt! + this.deps.config.resultMs, r.settledAt);
    const events: RoundEvent[] = [];
    if (lost.length) events.push({ type: 'bets.lost', roundId: r.id, betIds: lost.map((b) => b.betId) });
    events.push({ type: 'round.settled', roundId: r.id, crashX100: r.crashX100, seed: r.seed, settledAt: r.settledAt, nextRoundAt });
    await this.persist(events);

    this.history.unshift({ roundId: r.id, crashX100: r.crashX100, seed: r.seed, seedHash: r.seedHash, settledAt: r.settledAt });
    if (this.history.length > HISTORY_SIZE) this.history.pop();
    this.schedule('next', nextRoundAt, () => this.openBetting(r.id + 1));
  }

  // ── command handlers (decide inside the serial queue, write outside it) ──

  private beginPlaceBet(input: PlaceBetInput): Step {
    const r = this.round;
    if (!this.running || !r || r.phase !== 'BETTING' || input.receivedAt >= r.bettingEndsAt) {
      return { ok: false, error: 'BETTING_CLOSED' };
    }
    const existingByKey = r.betKeys.get(input.idempotencyKey);
    if (existingByKey !== undefined) {
      if (existingByKey !== input.userId) return { ok: false, error: 'VALIDATION_ERROR' };
      const pending = r.pendingBets.get(input.userId);
      return pending ? { wait: pending } : { ok: true, bet: toPublic(r.bets.get(input.userId)!) };
    }
    if (r.bets.has(input.userId) || r.pendingBets.has(input.userId)) return { ok: false, error: 'ALREADY_BET' };

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

    // Reserve synchronously: a retry or a second bet from the same user sees it at once.
    r.betKeys.set(input.idempotencyKey, input.userId);
    const betId = randomUUID();
    const write = (async (): Promise<BetResult> => {
      try {
        const debit = await this.deps.ledger.debitStake({
          betId,
          userId: input.userId,
          roundId: r.id,
          amount: input.amount,
          autoX100: auto,
          clientKey: input.idempotencyKey,
          placedAt: input.receivedAt,
          idempotencyKey: `bet:${r.id}:${input.userId}`,
          fencingToken: this.token,
        });
        if (!debit.ok) {
          r.betKeys.delete(input.idempotencyKey);
          return { ok: false, error: debit.reason };
        }
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
          clientKey: input.idempotencyKey,
          placedAt: input.receivedAt,
          cashedAt: null,
        };
        r.bets.set(input.userId, bet);
        this.emit({ type: 'bet.placed', bet: toPublic(bet) });
        if (debit.balance !== null) this.deps.onBalance?.(bet.userId, debit.balance, bet.isBot);
        return { ok: true, bet: toPublic(bet), balance: debit.balance };
      } catch (e) {
        r.betKeys.delete(input.idempotencyKey);
        return this.writeFailed(e);
      } finally {
        r.pendingBets.delete(input.userId);
      }
    })();
    r.pendingBets.set(input.userId, write);
    this.track(r, write);
    return { wait: write };
  }

  private beginCashout(input: CashoutInput): Step {
    const r = this.round;
    if (!r || r.id !== input.roundId) return { ok: false, error: 'ROUND_MISMATCH' };
    const bet = r.bets.get(input.userId);
    if (!bet) return { ok: false, error: 'NO_ACTIVE_BET' };
    if (bet.cashing) return { wait: bet.cashing }; // same click retried while its write is in flight
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
    const write =
      bet.autoX100 !== null && autoCashoutWins(bet.autoX100, r.crashX100) && bet.autoX100 <= decision.x100
        ? this.startCashout(r, bet, bet.autoX100, true, r.startedAt! + elapsedMsForX100(bet.autoX100, this.deps.config.k))
        : this.startCashout(r, bet, decision.x100, false, input.receivedAt);
    if (r.phase === 'RUNNING') this.scheduleNextAuto();
    return { wait: write };
  }

  /** The decision is final when this is called; it only writes it and announces it. */
  private startCashout(r: RoundState, bet: BetState, x100: number, auto: boolean, cashedAt: number): Promise<BetResult> {
    const payout = payoutFor(bet.amount, x100);
    const write = (async (): Promise<BetResult> => {
      try {
        const balance = await this.deps.ledger.creditCashout({
          betId: bet.betId,
          userId: bet.userId,
          roundId: bet.roundId,
          stake: bet.amount,
          payout,
          x100,
          auto,
          cashedAt,
          idempotencyKey: `cashout:${bet.betId}`,
          fencingToken: this.token,
        });
        bet.status = 'CASHED_OUT';
        bet.cashoutX100 = x100;
        bet.payout = payout;
        bet.cashedAt = cashedAt;
        this.emit({ type: 'bet.cashed_out', bet: toPublic(bet), auto });
        if (balance !== null) this.deps.onBalance?.(bet.userId, balance, bet.isBot);
        return { ok: true, bet: toPublic(bet) };
      } catch (e) {
        return this.writeFailed(e);
      } finally {
        bet.cashing = undefined;
      }
    })();
    bet.cashing = write;
    this.track(r, write);
    return write;
  }

  private track(r: RoundState, p: Promise<unknown>): void {
    r.inflight.add(p);
    void p.catch(() => undefined).finally(() => r.inflight.delete(p));
  }

  private async drainInflight(r: RoundState): Promise<void> {
    while (r.inflight.size) await Promise.allSettled([...r.inflight]);
  }

  /** A write that failed after the decision: fenced out means a newer leader owns the round. */
  private writeFailed(e: unknown): BetResult {
    this.fail(e);
    return { ok: false, error: 'NOT_LEADER' };
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /** Persist first, broadcast second: clients never see a state that a failover could undo. */
  private async persist(events: RoundEvent[]): Promise<void> {
    const r = this.round!;
    await this.deps.store.save(
      {
        id: r.id,
        seedHash: r.seedHash,
        crashX100: r.crashX100,
        phase: r.phase,
        bettingEndsAt: r.bettingEndsAt,
        startedAt: r.startedAt,
        crashAt: r.crashAt,
        crashedAt: r.crashedAt,
        settledAt: r.settledAt,
        seed: r.phase === 'SETTLED' ? r.seed : null,
      },
      this.token,
      events,
    );
    for (const e of events) this.emit(e);
  }

  private guardStep(fn: () => Step): Step {
    if (!this.running) return { ok: false, error: 'NOT_LEADER' };
    return fn();
  }

  /** Command wrapper: a fenced-out leader answers NOT_LEADER instead of throwing at the caller. */
  private async guard(fn: () => Promise<BetResult>): Promise<BetResult>;
  private async guard(fn: () => Promise<void>): Promise<void>;
  private async guard(fn: () => Promise<BetResult | void>): Promise<BetResult | void> {
    if (!this.running) return { ok: false, error: 'NOT_LEADER' };
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FencedOutError) {
        this.fail(e);
        return { ok: false, error: 'NOT_LEADER' };
      }
      throw e;
    }
  }

  private schedule(name: string, at: number, fn: () => Promise<void>): void {
    this.clearTimer(name);
    if (!this.running) return;
    const scheduledAt = this.deps.clock.now();
    const delay = Math.max(0, at - scheduledAt);
    const handle = setTimeout(() => {
      this.timers.delete(name);
      // Timer lateness only: a transition already overdue when scheduled (e.g. resuming after a
      // failover) is not the event loop's fault and must not pollute the latency metric.
      this.recordLatency(this.deps.clock.now() - Math.max(at, scheduledAt));
      void this.queue.run(() => (this.running ? fn() : undefined)).catch((e) => this.fail(e));
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
    if (err instanceof FencedOutError) {
      this.stop();
      this.deps.onFenced?.();
      return;
    }
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
