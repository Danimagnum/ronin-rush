import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { COMMAND_STREAM, CommandBus, compareStreamIds, type BusCommand } from '../src/realtime/command-bus';
import { RedisDrainBarrier } from '../src/realtime/redis-drain-barrier';
import type { BetResult } from '../src/round/round-engine';

// Own logical DB: never share the command stream with a dev stack running on DB 0.
const REDIS_URL = process.env.REDIS_URL ? process.env.REDIS_URL.replace(/\/\d*$/, '') + '/2' : undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = { now: () => Date.now() };

describe('compareStreamIds', () => {
  it('orders by ms then sequence', () => {
    expect(compareStreamIds('10-0', '9-5')).toBeGreaterThan(0);
    expect(compareStreamIds('10-1', '10-2')).toBeLessThan(0);
    expect(compareStreamIds('10-2', '10-2')).toBe(0);
  });
});

describe.skipIf(!REDIS_URL)('CommandBus (real Redis)', () => {
  let redis: Redis;
  const buses: CommandBus[] = [];

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!);
  });
  afterEach(async () => {
    await Promise.all(buses.splice(0).map((b) => b.stop()));
    await redis.del(COMMAND_STREAM, 'ronin:commands:cursor');
    const keys = await redis.keys('ronin:wm:*');
    if (keys.length) await redis.del(...keys);
  });
  afterAll(() => redis.disconnect());

  function bus(instanceId: string, leader: boolean, handler: (c: BusCommand) => Promise<BetResult>) {
    const b = new CommandBus(redis, { instanceId, clock, isLeader: () => leader, handler, replyTimeoutMs: 1_000 });
    buses.push(b);
    return b;
  }

  const cashout = (receivedAt: number): BusCommand => ({
    kind: 'cashout',
    input: { userId: 'u1', roundId: 1, idempotencyKey: 'key-123456', receivedAt },
  });

  it('forwards an edge command to the leader with its original receive time and returns the reply', async () => {
    const seen: number[] = [];
    const leader = bus('leader', true, async (c) => {
      seen.push(c.input.receivedAt);
      return { ok: false, error: 'CASHOUT_AFTER_CRASH' };
    });
    const edge = bus('edge', false, async () => {
      throw new Error('edge must not handle');
    });
    await leader.start();
    await edge.start();
    await leader.startConsuming();

    const receivedAt = Date.now() - 123;
    expect(await edge.submit(cashout(receivedAt))).toEqual({ ok: false, error: 'CASHOUT_AFTER_CRASH' });
    expect(seen).toEqual([receivedAt]);
    expect(compareStreamIds(leader.lastConsumedId, (await leader.streamTip())!)).toBe(0);
  });

  it('times out cleanly when there is no leader consuming', async () => {
    const edge = bus('edge', false, async () => ({ ok: false, error: 'NOT_LEADER' }));
    await edge.start();
    expect(await edge.submit(cashout(Date.now()))).toEqual({ ok: false, error: 'TIMEOUT' });
  });

  it('a new leader picks up commands queued during the hand-over', async () => {
    const edge = bus('edge', false, async () => ({ ok: false, error: 'NOT_LEADER' }));
    await edge.start();
    const pending = edge.submit(cashout(Date.now()));
    await sleep(100); // nobody consuming yet
    const handled: BusCommand[] = [];
    const leader = bus('leader', true, async (c) => {
      handled.push(c);
      return { ok: false, error: 'NO_ACTIVE_BET' };
    });
    await leader.start();
    await redis.set('ronin:commands:cursor', '0-0');
    await leader.startConsuming();
    expect(await pending).toEqual({ ok: false, error: 'NO_ACTIVE_BET' });
    expect(handled).toHaveLength(1);
  });

  it('watermark is the oldest in-flight receive time, else now', async () => {
    const edge = bus('edge', false, async () => ({ ok: false, error: 'NOT_LEADER' }));
    await edge.start();
    const before = Date.now();
    expect(edge.watermark()).toBeGreaterThanOrEqual(before);
    void edge.submit(cashout(before - 500)); // XADD in flight
    expect(edge.watermark()).toBe(before - 500);
  });

  describe('RedisDrainBarrier', () => {
    it('waits for lagging edges, then for the leader to consume the stream tip', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const leader = bus('leader', true, async () => {
        await gate;
        return { ok: false, error: 'NO_ACTIVE_BET' };
      });
      await leader.start();
      const barrier = new RedisDrainBarrier(leader);
      const crashedAt = Date.now();

      // A slow edge whose watermark is still before the crash.
      await redis.set('ronin:wm:slow-edge', String(crashedAt - 50), 'PX', 2_000);
      let drained = false;
      const p = barrier.waitUntilDrained(crashedAt, 2_000).then(() => (drained = true));
      await sleep(100);
      expect(drained).toBe(false);

      // It forwards its pre-crash command and advances its watermark.
      await redis.xadd(COMMAND_STREAM, '*', 'c', JSON.stringify({ corr: 'x', replyTo: 'slow-edge', cmd: cashout(crashedAt - 1) }));
      await redis.set('ronin:wm:slow-edge', String(crashedAt + 10), 'PX', 2_000);
      await sleep(100);
      expect(drained).toBe(false); // the leader has not consumed it yet

      await leader.startConsuming();
      await p;
      expect(drained).toBe(true);
      expect(barrier.timeouts).toBe(0);
      release();
    });

    it('gives up after the timeout instead of blocking settlement forever', async () => {
      const leader = bus('leader', true, async () => ({ ok: false, error: 'NO_ACTIVE_BET' }));
      await leader.start();
      let lagging: string[] = [];
      const barrier = new RedisDrainBarrier(leader, (l) => (lagging = l));
      await redis.set('ronin:wm:stuck', '0', 'PX', 5_000);
      await barrier.waitUntilDrained(Date.now(), 150);
      expect(barrier.timeouts).toBe(1);
      expect(lagging).toEqual(['stuck']);
    });
  });
});
