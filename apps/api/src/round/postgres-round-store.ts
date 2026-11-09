import type { RoundEvent } from '@ronin/shared';
import type { DataSource } from 'typeorm';
import { claimFence } from '../db/fence';
import { appendRoundEvents } from '../db/outbox';
import { num, withTransaction } from '../db/tx';
import type { PersistedBet, PersistedRound, RoundStore, SettledRound } from './ports';

const nullableNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PostgresRoundStore implements RoundStore {
  constructor(
    private readonly ds: DataSource,
    private readonly chainId: number,
  ) {}

  async save(round: PersistedRound, fencingToken: number, events: RoundEvent[]): Promise<void> {
    await withTransaction(this.ds, async (q) => {
      await claimFence(q, fencingToken);
      await q.query(
        `INSERT INTO rounds (id, chain_id, seed_hash, seed, crash_x100, phase, betting_ends_at, started_at,
                             crash_at, crashed_at, settled_at, fencing_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           seed = EXCLUDED.seed, phase = EXCLUDED.phase, started_at = EXCLUDED.started_at,
           crash_at = EXCLUDED.crash_at, crashed_at = EXCLUDED.crashed_at, settled_at = EXCLUDED.settled_at,
           fencing_token = EXCLUDED.fencing_token, updated_at = now()`,
        [
          round.id,
          this.chainId,
          round.seedHash,
          round.seed,
          round.crashX100,
          round.phase,
          round.bettingEndsAt,
          round.startedAt,
          round.crashAt,
          round.crashedAt,
          round.settledAt,
          fencingToken,
        ],
      );
      await appendRoundEvents(q, events);
    });
  }

  async latest(): Promise<PersistedRound | null> {
    const [r] = await this.ds.query(`SELECT * FROM rounds ORDER BY id DESC LIMIT 1`);
    return r ? toRound(r) : null;
  }

  async bets(roundId: number): Promise<PersistedBet[]> {
    const rows = await this.ds.query(
      `SELECT b.*, u.username, u.is_bot FROM bets b JOIN users u ON u.id = b.user_id WHERE b.round_id = $1 ORDER BY b.created_at`,
      [roundId],
    );
    return rows.map(
      (b: Record<string, unknown>): PersistedBet => ({
        betId: b.id as string,
        roundId: num(b.round_id),
        userId: b.user_id as string,
        username: b.username as string,
        isBot: b.is_bot as boolean,
        amount: num(b.amount),
        autoX100: nullableNum(b.auto_x100),
        status: b.status as PersistedBet['status'],
        cashoutX100: nullableNum(b.cashout_x100),
        payout: nullableNum(b.payout),
        clientKey: b.client_key as string,
        placedAt: num(b.placed_at),
        cashedAt: nullableNum(b.cashed_at),
      }),
    );
  }

  async recent(limit: number): Promise<SettledRound[]> {
    const rows = await this.ds.query(
      `SELECT id, crash_x100, seed, seed_hash, settled_at FROM rounds WHERE phase = 'SETTLED' ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r: Record<string, unknown>) => ({
      roundId: num(r.id),
      crashX100: num(r.crash_x100),
      seed: r.seed as string,
      seedHash: r.seed_hash as string,
      settledAt: num(r.settled_at),
    }));
  }
}

function toRound(r: Record<string, unknown>): PersistedRound {
  return {
    id: num(r.id),
    seedHash: r.seed_hash as string,
    crashX100: num(r.crash_x100),
    phase: r.phase as PersistedRound['phase'],
    bettingEndsAt: num(r.betting_ends_at),
    startedAt: nullableNum(r.started_at),
    crashAt: nullableNum(r.crash_at),
    crashedAt: nullableNum(r.crashed_at),
    settledAt: nullableNum(r.settled_at),
    seed: (r.seed as string | null) ?? null,
  };
}
