import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeaderElector } from '../src/leader/leader-elector';

/**
 * Runs against a real Redis (REDIS_URL, e.g. the docker-compose service). Skipped when absent
 * so `pnpm test` still works on a machine with nothing running.
 */
const REDIS_URL = process.env.REDIS_URL;
const KEY = `ronin:test:leader:${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!REDIS_URL)('LeaderElector (real Redis)', () => {
  let redis: Redis;
  const make = (id: string) => new LeaderElector(redis, { instanceId: id, key: KEY, ttlMs: 400, renewEveryMs: 100 });

  beforeAll(() => {
    redis = new Redis(REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
  });
  beforeEach(async () => {
    await redis.del(KEY, `${KEY}:fencing`);
  });
  afterAll(async () => {
    await redis.del(KEY, `${KEY}:fencing`);
    redis.disconnect();
  });

  it('elects exactly one leader among concurrent contenders', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(make);
    await Promise.all(nodes.map((n) => n.start()));
    await sleep(350);
    expect(nodes.filter((n) => n.isLeader)).toHaveLength(1);
    expect(nodes.find((n) => n.isLeader)!.fencingToken).toBe(1);
    await Promise.all(nodes.map((n) => n.stop()));
  });

  it('keeps the lease while renewing, well past the TTL', async () => {
    const a = make('a');
    await a.start();
    await sleep(1_000); // 2.5 × TTL
    expect(a.isLeader).toBe(true);
    expect(await redis.pttl(KEY)).toBeGreaterThan(0);
    await a.stop();
  });

  it('fails over on graceful stop with a higher fencing token', async () => {
    const a = make('a');
    const b = make('b');
    await a.start();
    await b.start();
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    const changes: Array<[boolean, number | null]> = [];
    b.onChange((l, t) => changes.push([l, t]));

    await a.stop(); // releases the lease immediately
    await sleep(250);
    expect(b.isLeader).toBe(true);
    expect(b.fencingToken).toBe(2);
    expect(changes).toEqual([[true, 2]]);
    await b.stop();
  });

  it('fails over when the leader dies without releasing (lease expiry)', async () => {
    const a = make('a');
    const b = make('b');
    await a.start();
    await b.start();
    // Simulate a crash: stop renewing without releasing.
    (a as unknown as { interval: NodeJS.Timeout }).interval && clearInterval((a as unknown as { interval: NodeJS.Timeout }).interval);
    await sleep(700); // ttl 400 + renew 100 + slack
    expect(b.isLeader).toBe(true);
    expect(b.fencingToken).toBeGreaterThan(a.fencingToken!);
    await b.stop();
  });

  it('steps down as soon as it sees another owner of the lease', async () => {
    const a = make('a');
    await a.start();
    await redis.set(KEY, 'intruder', 'PX', 5_000);
    await sleep(250);
    expect(a.isLeader).toBe(false);
    await a.stop();
    expect(await redis.get(KEY)).toBe('intruder'); // never deletes someone else's lease
  });
});
