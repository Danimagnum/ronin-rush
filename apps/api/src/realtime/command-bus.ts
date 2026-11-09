import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Clock } from '../clock/clock';
import type { BetResult, CashoutInput, PlaceBetInput } from '../round/round-engine';

export type BusCommand = { kind: 'bet'; input: PlaceBetInput } | { kind: 'cashout'; input: CashoutInput };
export type BusHandler = (cmd: BusCommand) => Promise<BetResult>;

export const COMMAND_STREAM = 'ronin:commands';
const CURSOR_KEY = 'ronin:commands:cursor';
const WATERMARK_PREFIX = 'ronin:wm:';

/** Stream ids are "ms-seq"; compare numerically. */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number) as [number, number];
  const [bm, bs] = b.split('-').map(Number) as [number, number];
  return am - bm || as - bs;
}

export interface CommandBusOptions {
  instanceId: string;
  clock: Clock;
  isLeader: () => boolean;
  handler: BusHandler;
  replyTimeoutMs?: number;
  watermarkEveryMs?: number;
  /** Pub/sub channels are server-wide (not per logical DB): namespace them per environment. */
  channelPrefix?: string;
}

/**
 * Routes player commands from whichever instance holds the socket to the leader.
 *
 *  edge instance                                   leader
 *  ─────────────                                   ──────
 *  receivedAt = clock.now()   (stamped first)
 *  XADD ronin:commands {cmd, corr, replyTo}  ───▶  XREAD → engine (decides with receivedAt)
 *  await reply on ronin:reply:<me>           ◀───  PUBLISH result
 *
 * Watermarks: every edge publishes "I have forwarded everything I received before T"
 * (T = oldest in-flight receivedAt, or now). After a crash at C the leader waits until all
 * live watermarks are >= C and it has consumed the stream up to its tip before settling, so a
 * cash-out received 1 ms before the crash on another machine is still honoured.
 */
export class CommandBus {
  private readonly blocking: Redis;
  private readonly sub: Redis;
  private readonly inFlight = new Map<string, number>(); // corr -> receivedAt
  private readonly waiters = new Map<string, (r: BetResult) => void>();
  private consuming = false;
  private consumerDone: Promise<void> = Promise.resolve();
  private wmTimer: NodeJS.Timeout | null = null;
  private cursor = '0-0';
  /** Id of the last stream entry handed to the engine (leader only). */
  lastConsumedId = '0-0';
  forwarded = 0;
  consumed = 0;

  private readonly replyChannel = (instanceId: string) => `${this.opts.channelPrefix ?? 'ronin'}:reply:${instanceId}`;

  constructor(
    private readonly redis: Redis,
    private readonly opts: CommandBusOptions,
  ) {
    this.blocking = redis.duplicate();
    this.sub = redis.duplicate();
  }

  async start(): Promise<void> {
    await this.sub.subscribe(this.replyChannel(this.opts.instanceId));
    this.sub.on('message', (_ch, msg) => {
      const { corr, result } = JSON.parse(msg) as { corr: string; result: BetResult };
      const resolve = this.waiters.get(corr);
      if (resolve) {
        this.waiters.delete(corr);
        resolve(result);
      }
    });
    this.wmTimer = setInterval(() => void this.publishWatermark(), this.opts.watermarkEveryMs ?? 25);
    await this.publishWatermark();
  }

  async stop(): Promise<void> {
    if (this.wmTimer) clearInterval(this.wmTimer);
    await this.stopConsuming();
    await this.redis.del(WATERMARK_PREFIX + this.opts.instanceId).catch(() => undefined);
    this.sub.disconnect();
    this.blocking.disconnect();
  }

  // ── edge side ────────────────────────────────────────────────────────────

  /** `cmd.input.receivedAt` must already be stamped, synchronously, before calling this. */
  submit(cmd: BusCommand): Promise<BetResult> {
    if (this.opts.isLeader()) return this.opts.handler(cmd);

    const corr = randomUUID();
    this.inFlight.set(corr, cmd.input.receivedAt); // synchronous: the watermark can't overtake it
    const reply = new Promise<BetResult>((resolve) => {
      this.waiters.set(corr, resolve);
      setTimeout(() => {
        if (this.waiters.delete(corr)) resolve({ ok: false, error: 'TIMEOUT' });
      }, this.opts.replyTimeoutMs ?? 3_000);
    });
    this.redis
      .xadd(COMMAND_STREAM, 'MAXLEN', '~', '10000', '*', 'c', JSON.stringify({ corr, replyTo: this.opts.instanceId, cmd }))
      .then(() => this.forwarded++)
      .catch(() => {
        const resolve = this.waiters.get(corr);
        this.waiters.delete(corr);
        resolve?.({ ok: false, error: 'NOT_LEADER' });
      })
      .finally(() => this.inFlight.delete(corr));
    return reply;
  }

  /** Everything this instance received strictly before the returned time is in the stream. */
  watermark(): number {
    let min = Infinity;
    for (const t of this.inFlight.values()) if (t < min) min = t;
    return min === Infinity ? this.opts.clock.now() : min;
  }

  private async publishWatermark(): Promise<void> {
    await this.redis.set(WATERMARK_PREFIX + this.opts.instanceId, String(this.watermark()), 'PX', 1_000).catch(() => undefined);
  }

  // ── leader side ──────────────────────────────────────────────────────────

  async startConsuming(): Promise<void> {
    if (this.consuming) return;
    this.consuming = true;
    // Resume after the last entry a previous leader handled; commands queued during the
    // hand-over are still processed (the engine judges them by their receive time).
    const saved = await this.redis.get(CURSOR_KEY);
    const tip = await this.redis.xrevrange(COMMAND_STREAM, '+', '-', 'COUNT', 1);
    this.cursor = saved ?? tip[0]?.[0] ?? '0-0';
    this.lastConsumedId = this.cursor;
    this.consumerDone = this.consumeLoop();
  }

  async stopConsuming(): Promise<void> {
    this.consuming = false;
    await this.consumerDone;
  }

  private async consumeLoop(): Promise<void> {
    while (this.consuming) {
      let res: Array<[string, Array<[string, string[]]>]> | null;
      try {
        res = (await this.blocking.xread('COUNT', 200, 'BLOCK', 100, 'STREAMS', COMMAND_STREAM, this.cursor)) as typeof res;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          this.dispatch(fields[1]!);
          this.cursor = id;
          this.lastConsumedId = id;
          this.consumed++;
        }
      }
      await this.redis.set(CURSOR_KEY, this.cursor).catch(() => undefined);
    }
  }

  /** Hands the command to the engine synchronously (it enqueues in order), replies when done. */
  private dispatch(raw: string): void {
    let msg: { corr: string; replyTo: string; cmd: BusCommand };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    void this.opts
      .handler(msg.cmd)
      .catch((): BetResult => ({ ok: false, error: 'NOT_LEADER' }))
      .then((result) => this.redis.publish(this.replyChannel(msg.replyTo), JSON.stringify({ corr: msg.corr, result })));
  }

  // ── drain support ────────────────────────────────────────────────────────

  async liveWatermarks(): Promise<Array<{ instanceId: string; watermark: number }>> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${WATERMARK_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (!keys.length) return [];
    const values = await this.redis.mget(keys);
    return keys
      .map((k, i) => ({ instanceId: k.slice(WATERMARK_PREFIX.length), watermark: Number(values[i]) }))
      .filter((w) => Number.isFinite(w.watermark));
  }

  async streamTip(): Promise<string | null> {
    const tip = await this.redis.xrevrange(COMMAND_STREAM, '+', '-', 'COUNT', 1);
    return tip[0]?.[0] ?? null;
  }
}
