import { crashPointX100, generateHashChain, type RoundEvent } from '@ronin/shared';
import { RoundEngine, type RoundEngineConfig } from '../src/round/round-engine';
import { ChainSeedSource, ImmediateDrainBarrier, InMemoryLedger } from '../src/round/in-memory';
import type { DrainBarrier, RoundSeed, SeedSource } from '../src/round/ports';

export const SALT = 'test-salt';
export const CONFIG: RoundEngineConfig = {
  bettingMs: 8_000,
  resultMs: 3_000,
  drainTimeoutMs: 1_000,
  k: 0.00006,
  publicSalt: SALT,
  minBetCents: 10,
  maxBetCents: 1_000_000,
};

const POOL = generateHashChain(3_000, 'd4'.repeat(32)).seeds.map((seed) => ({
  seed,
  crashX100: crashPointX100(seed, SALT),
}));

/** Picks real chain seeds whose crash point satisfies each predicate, in order. */
export function seedsWhere(...predicates: Array<(crashX100: number) => boolean>): Array<{ seed: string; crashX100: number }> {
  const used = new Set<string>();
  return predicates.map((p) => {
    const found = POOL.find((s) => !used.has(s.seed) && p(s.crashX100));
    if (!found) throw new Error('no seed in pool matches predicate');
    used.add(found.seed);
    return found;
  });
}

export class ListSeedSource implements SeedSource {
  readonly commitment = '0'.repeat(64);
  private i = 0;
  constructor(private readonly seeds: string[]) {}
  async next(): Promise<RoundSeed> {
    const seed = this.seeds[this.i] ?? this.seeds.at(-1)!;
    this.i++;
    return { roundId: this.i, seed };
  }
}

/** Drain barrier the test opens by hand, to simulate cash-outs still in flight from relays. */
export class ManualDrain implements DrainBarrier {
  private release: (() => void) | null = null;
  waitUntilDrained(): Promise<void> {
    return new Promise((resolve) => (this.release = resolve));
  }
  open(): void {
    this.release?.();
  }
}

export function makeEngine(opts: { seeds: string[]; drain?: DrainBarrier; balance?: number }) {
  const events: RoundEvent[] = [];
  const ledger = new InMemoryLedger(opts.balance ?? 100_000);
  const clock = { now: () => Date.now() };
  const engine = new RoundEngine({
    clock,
    seeds: new ListSeedSource(opts.seeds),
    ledger,
    drain: opts.drain ?? new ImmediateDrainBarrier(),
    events: { emit: (e) => events.push(e) },
    config: CONFIG,
    onError: (e) => {
      throw e;
    },
  });
  const ofType = <T extends RoundEvent['type']>(t: T) => events.filter((e): e is Extract<RoundEvent, { type: T }> => e.type === t);
  return { engine, events, ledger, clock, ofType };
}

export { ChainSeedSource };
