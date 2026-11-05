import { sha256Hex } from '@ronin/shared';
import type {
  BetLedger,
  CashoutCredit,
  DebitResult,
  DrainBarrier,
  LostStake,
  RoundSeed,
  SeedSource,
  StakeDebit,
} from './ports';

/** Walks a pre-generated hash chain forwards: round r uses seeds[r-1]. */
export class ChainSeedSource implements SeedSource {
  readonly commitment: string;
  private index: number;

  constructor(
    private readonly seeds: readonly string[],
    startRoundId = 1,
  ) {
    if (seeds.length === 0) throw new Error('empty chain');
    this.commitment = sha256Hex(seeds[0]!);
    this.index = startRoundId - 1;
  }

  async next(): Promise<RoundSeed> {
    const seed = this.seeds[this.index];
    if (!seed) throw new Error('Hash chain exhausted: generate and publish a new chain');
    this.index++;
    return { roundId: this.index, seed };
  }
}

export class ImmediateDrainBarrier implements DrainBarrier {
  async waitUntilDrained(): Promise<void> {}
}

/**
 * Reference ledger used by engine tests and single-process dev runs. Mirrors the Postgres
 * ledger's flows: user -> escrow on bet; escrow (+house for profit) -> user on cash-out;
 * escrow -> house on loss. Totals across all accounts never change.
 */
export class InMemoryLedger implements BetLedger {
  readonly balances = new Map<string, number>();
  escrow = 0;
  house = 0;
  private readonly applied = new Set<string>();

  constructor(private readonly defaultBalance = 100_000) {}

  balanceOf(userId: string): number {
    if (!this.balances.has(userId)) this.balances.set(userId, this.defaultBalance);
    return this.balances.get(userId)!;
  }

  async debitStake(op: StakeDebit): Promise<DebitResult> {
    if (this.applied.has(op.idempotencyKey)) return { ok: true };
    const bal = this.balanceOf(op.userId);
    if (bal < op.amount) return { ok: false, reason: 'INSUFFICIENT_FUNDS' };
    this.balances.set(op.userId, bal - op.amount);
    this.escrow += op.amount;
    this.applied.add(op.idempotencyKey);
    return { ok: true };
  }

  async creditCashout(op: CashoutCredit): Promise<void> {
    if (this.applied.has(op.idempotencyKey)) return;
    this.escrow -= op.stake;
    this.house -= op.payout - op.stake;
    this.balances.set(op.userId, this.balanceOf(op.userId) + op.payout);
    this.applied.add(op.idempotencyKey);
  }

  async settleLosses(_roundId: number, lost: LostStake[], idempotencyKey: string): Promise<void> {
    if (this.applied.has(idempotencyKey)) return;
    const total = lost.reduce((s, l) => s + l.amount, 0);
    this.escrow -= total;
    this.house += total;
    this.applied.add(idempotencyKey);
  }

  total(): number {
    let sum = this.escrow + this.house;
    for (const v of this.balances.values()) sum += v;
    return sum;
  }
}
