import { sha256Hex, type RoundEvent } from '@ronin/shared';
import type {
  BetLedger,
  CashoutCredit,
  DebitResult,
  DrainBarrier,
  LostStake,
  PersistedBet,
  PersistedRound,
  RoundStore,
  SeedSource,
  SettledRound,
  StakeDebit,
} from './ports';
import { FencedOutError } from './ports';

/** Hash chain held in memory: round r uses seeds[r-1]. */
export class ChainSeedSource implements SeedSource {
  readonly commitment: string;

  constructor(private readonly seeds: readonly string[]) {
    if (seeds.length === 0) throw new Error('empty chain');
    this.commitment = sha256Hex(seeds[0]!);
  }

  async seedFor(roundId: number): Promise<string> {
    const seed = this.seeds[roundId - 1];
    if (!seed) throw new Error('Hash chain exhausted: generate and publish a new chain');
    return seed;
  }
}

export class ImmediateDrainBarrier implements DrainBarrier {
  async waitUntilDrained(): Promise<void> {}
}

/** Shared fence for the in-memory store and ledger, mirroring the leader_fence row. */
export class MemoryFence {
  token = 0;
  check(t: number): void {
    if (t < this.token) throw new FencedOutError(t);
  }
  bump(t: number): void {
    this.check(t);
    this.token = t;
  }
}

/**
 * Reference ledger for engine tests and DB-less dev runs. Mirrors the Postgres ledger's flows:
 * user -> escrow on bet; escrow (+house for profit) -> user on cash-out; escrow -> house on loss.
 */
export class InMemoryLedger implements BetLedger {
  readonly balances = new Map<string, number>();
  readonly bets = new Map<string, PersistedBet>();
  readonly usernames = new Map<string, string>();
  escrow = 0;
  house = 0;
  private readonly applied = new Set<string>();

  constructor(
    private readonly defaultBalance = 100_000,
    readonly fence = new MemoryFence(),
  ) {}

  balanceOf(userId: string): number {
    if (!this.balances.has(userId)) this.balances.set(userId, this.defaultBalance);
    return this.balances.get(userId)!;
  }

  async debitStake(op: StakeDebit): Promise<DebitResult> {
    this.fence.check(op.fencingToken);
    if (this.applied.has(op.idempotencyKey)) return { ok: true, balance: this.balanceOf(op.userId) };
    const bal = this.balanceOf(op.userId);
    if (bal < op.amount) return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
    this.balances.set(op.userId, bal - op.amount);
    this.escrow += op.amount;
    this.bets.set(op.betId, {
      betId: op.betId,
      roundId: op.roundId,
      userId: op.userId,
      username: this.usernames.get(op.userId) ?? op.userId,
      isBot: false,
      amount: op.amount,
      autoX100: op.autoX100,
      status: 'ACTIVE',
      cashoutX100: null,
      payout: null,
      clientKey: op.clientKey,
      placedAt: op.placedAt,
      cashedAt: null,
    });
    this.applied.add(op.idempotencyKey);
    return { ok: true, balance: bal - op.amount };
  }

  async creditCashout(op: CashoutCredit): Promise<void> {
    this.fence.check(op.fencingToken);
    if (this.applied.has(op.idempotencyKey)) return;
    this.escrow -= op.stake;
    this.house -= op.payout - op.stake;
    this.balances.set(op.userId, this.balanceOf(op.userId) + op.payout);
    const bet = this.bets.get(op.betId);
    if (bet) Object.assign(bet, { status: 'CASHED_OUT', cashoutX100: op.x100, payout: op.payout, cashedAt: op.cashedAt });
    this.applied.add(op.idempotencyKey);
  }

  async settleLosses(_roundId: number, lost: LostStake[], idempotencyKey: string, fencingToken: number): Promise<void> {
    this.fence.check(fencingToken);
    if (this.applied.has(idempotencyKey)) return;
    const total = lost.reduce((s, l) => s + l.amount, 0);
    this.escrow -= total;
    this.house += total;
    for (const l of lost) {
      const bet = this.bets.get(l.betId);
      if (bet) Object.assign(bet, { status: 'LOST', payout: 0 });
    }
    this.applied.add(idempotencyKey);
  }

  total(): number {
    let sum = this.escrow + this.house;
    for (const v of this.balances.values()) sum += v;
    return sum;
  }
}

export class InMemoryRoundStore implements RoundStore {
  readonly rounds = new Map<number, PersistedRound>();
  readonly outbox: RoundEvent[] = [];

  constructor(
    private readonly ledger: InMemoryLedger,
    private readonly fence: MemoryFence = ledger.fence,
  ) {}

  async save(round: PersistedRound, fencingToken: number, events: RoundEvent[]): Promise<void> {
    this.fence.bump(fencingToken);
    this.rounds.set(round.id, { ...round });
    this.outbox.push(...events);
  }

  async latest(): Promise<PersistedRound | null> {
    const ids = [...this.rounds.keys()];
    return ids.length ? { ...this.rounds.get(Math.max(...ids))! } : null;
  }

  async bets(roundId: number): Promise<PersistedBet[]> {
    return [...this.ledger.bets.values()].filter((b) => b.roundId === roundId).map((b) => ({ ...b }));
  }

  async recent(limit: number): Promise<SettledRound[]> {
    return [...this.rounds.values()]
      .filter((r) => r.phase === 'SETTLED')
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((r) => ({ roundId: r.id, crashX100: r.crashX100, seed: r.seed!, seedHash: r.seedHash, settledAt: r.settledAt! }));
  }
}
