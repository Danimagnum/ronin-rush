import { generateHashChain } from '@ronin/shared';
import type { DataSource } from 'typeorm';
import { withTransaction } from '../db/tx';
import type { SeedSource } from './ports';

export interface ActiveChain {
  chainId: number;
  commitment: string;
  length: number;
  publicSalt: string;
  created: boolean;
}

/**
 * Loads the active hash chain, or generates and stores one on first boot. The commitment is
 * fixed from that moment: publish it (README, /api/fairness) before players join.
 */
export async function ensureActiveChain(
  ds: DataSource,
  opts: { length: number; publicSalt: string; terminalSeed?: string | undefined },
): Promise<ActiveChain> {
  const [existing] = await ds.query(`SELECT id, commitment, length, public_salt FROM fairness_chains WHERE active`);
  if (existing) {
    if (existing.public_salt !== opts.publicSalt) {
      throw new Error('PUBLIC_SALT differs from the salt published with the active chain');
    }
    return { chainId: existing.id, commitment: existing.commitment, length: existing.length, publicSalt: existing.public_salt, created: false };
  }

  const chain = generateHashChain(opts.length, opts.terminalSeed);
  return withTransaction(ds, async (q) => {
    const [row] = await q.query(
      `INSERT INTO fairness_chains (commitment, length, public_salt) VALUES ($1, $2, $3) RETURNING id`,
      [chain.commitment, chain.seeds.length, opts.publicSalt],
    );
    const BATCH = 5_000;
    for (let start = 0; start < chain.seeds.length; start += BATCH) {
      const slice = chain.seeds.slice(start, start + BATCH);
      const values = slice.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(',');
      await q.query(
        `INSERT INTO seed_chain (chain_id, round_id, seed) VALUES ${values}`,
        [row.id, ...slice.flatMap((seed, i) => [start + i + 1, seed])],
      );
    }
    return { chainId: row.id, commitment: chain.commitment, length: chain.seeds.length, publicSalt: opts.publicSalt, created: true };
  });
}

export class PostgresSeedSource implements SeedSource {
  constructor(
    private readonly ds: DataSource,
    private readonly chain: ActiveChain,
  ) {}

  get commitment(): string {
    return this.chain.commitment;
  }

  async seedFor(roundId: number): Promise<string> {
    const [row] = await this.ds.query(`SELECT seed FROM seed_chain WHERE chain_id = $1 AND round_id = $2`, [this.chain.chainId, roundId]);
    if (!row) throw new Error(`Hash chain exhausted at round ${roundId}: generate and publish a new chain`);
    return row.seed;
  }
}
