import type { DataSource, QueryRunner } from 'typeorm';

/** Runs `fn` in a READ COMMITTED transaction; rolls back on any throw. */
export async function withTransaction<T>(ds: DataSource, fn: (q: QueryRunner) => Promise<T>): Promise<T> {
  const q = ds.createQueryRunner();
  await q.connect();
  await q.startTransaction('READ COMMITTED');
  try {
    const result = await fn(q);
    await q.commitTransaction();
    return result;
  } catch (e) {
    if (q.isTransactionActive) await q.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await q.release();
  }
}

/** Throw inside withTransaction to roll back and return a value instead of an error. */
export class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super('rollback');
  }
}

export async function withTransactionOr<T>(ds: DataSource, fn: (q: QueryRunner) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(ds, fn);
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
}

/** pg returns bigint as string; our values stay well inside Number.MAX_SAFE_INTEGER. */
export const num = (v: unknown): number => (v === null || v === undefined ? (v as never) : Number(v));

/** TypeORM returns [rows, affected] for UPDATE/DELETE; normalise to the RETURNING rows. */
export async function updateReturning<T = Record<string, unknown>>(q: QueryRunner, sql: string, params: unknown[]): Promise<T[]> {
  const res = await q.query(sql, params);
  return (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res) as T[];
}
