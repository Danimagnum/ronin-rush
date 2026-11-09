import type { QueryRunner } from 'typeorm';
import { FencedOutError } from '../round/ports';

/**
 * Shared-lock read of the fence: concurrent ledger writes of the same leader don't block each
 * other, but a new leader's `claimFence` waits for them and every later write sees the new token.
 */
export async function assertFence(q: QueryRunner, token: number): Promise<void> {
  const [row] = await q.query(`SELECT token FROM leader_fence WHERE id = 1 FOR SHARE`);
  if (Number(row.token) > token) throw new FencedOutError(token);
}

/** Exclusive bump, done by the leader on takeover and on every phase transition. */
export async function claimFence(q: QueryRunner, token: number): Promise<void> {
  const res = await q.query(`UPDATE leader_fence SET token = $1 WHERE id = 1 AND token <= $1`, [token]);
  // TypeORM returns [rows, affectedCount] for UPDATE on postgres
  const affected = Array.isArray(res) ? res[1] : res?.affected;
  if (!affected) throw new FencedOutError(token);
}

export async function currentFence(db: { query(sql: string): Promise<Array<{ token: string }>> }): Promise<number> {
  const [row] = await db.query(`SELECT token FROM leader_fence WHERE id = 1`);
  return Number(row?.token ?? 0);
}
