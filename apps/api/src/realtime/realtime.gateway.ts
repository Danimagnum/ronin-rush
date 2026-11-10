import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import { CashoutCommand, PlaceBetCommand, SOCKET_EVENTS, TimePing, type CommandError, type InstanceStatus, type RoundEvent } from '@ronin/shared';
import type Redis from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { AuthService, type Principal } from '../auth/auth.service';
import type { Clock, ReferenceAlignedClock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, ENV, REDIS } from '../config/tokens';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';
import type { BetResult } from '../round/round-engine';
import { ReadModel } from './read-model.service';

type Ack = (payload: unknown) => void;

export const INSTANCE_KEY_PREFIX = 'ronin:inst:';

/** Token bucket: `rate` commands per second, bursts up to `rate`. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number) {
    this.tokens = rate;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

const fail = (error: CommandError) => ({ ok: false, error });

/**
 * Socket.IO edge. Every instance runs one; the Redis adapter makes a broadcast from the leader
 * reach sockets connected to any instance.
 *
 * Timing rule: the very first statement of a command handler stamps `receivedAt` from the
 * Redis-aligned clock — before parsing, auth or any await — and that is the only time the
 * engine will ever use for the decision.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Realtime');
  io!: Server;
  private pub!: Redis;
  private sub!: Redis;
  private heartbeat: NodeJS.Timeout | null = null;
  private batch: RoundEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  localConnections = 0;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly auth: AuthService,
    private readonly runner: RoundRunner,
    private readonly hub: EventHub,
    private readonly readModel: ReadModel,
  ) {}

  onApplicationBootstrap(): void {
    const origin = this.env.CORS_ORIGIN === '*' ? true : this.env.CORS_ORIGIN.split(',');
    this.io = new Server(this.adapterHost.httpAdapter.getHttpServer(), {
      cors: { origin, credentials: true },
      transports: ['websocket', 'polling'],
      pingInterval: 10_000,
    });
    this.pub = this.redis.duplicate();
    this.sub = this.redis.duplicate();
    this.io.adapter(createAdapter(this.pub, this.sub, { key: `${this.env.REDIS_NAMESPACE}:sio` }));

    this.io.use(async (socket, next) => {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      socket.data.principal = await this.auth.verify(token).catch(() => null);
      next();
    });
    this.io.on('connection', (socket) => this.onConnection(socket));

    // Leader-side fan-out, delivered cluster-wide by the adapter. Phase changes go out at once;
    // bets and cash-outs are batched (≤100 ms), turning N events × M sockets into a handful of
    // messages per second per socket. A phase change flushes the batch first to keep ordering.
    this.hub.subscribe((e) => {
      if (!this.runner.isLeader) return;
      if (e.type === 'bet.placed' || e.type === 'bet.cashed_out') {
        this.batch.push(e);
        this.batchTimer ??= setTimeout(() => this.flushBatch(), 100);
        return;
      }
      this.flushBatch();
      this.io.emit(SOCKET_EVENTS.roundEvent, e);
    });
    this.runner.onBalance((userId, balance) => this.io.to(`user:${userId}`).emit(SOCKET_EVENTS.balance, { balance }));

    // Per-instance heartbeat: feeds the System view (connections, clock alignment, relay traffic).
    this.heartbeat = setInterval(() => {
      const sync = (this.clock as Partial<ReferenceAlignedClock>).lastSync ?? null;
      const status = {
        instanceId: this.env.INSTANCE_ID,
        leader: this.runner.isLeader,
        connections: this.localConnections,
        clockOffsetMs: sync?.offsetMs ?? 0,
        clockRttMs: sync?.rttMs ?? 0,
        commandsForwarded: this.runner.bus.forwarded,
        reportedAt: Date.now(),
      };
      void this.redis.set(`${INSTANCE_KEY_PREFIX}${this.env.INSTANCE_ID}`, JSON.stringify(status), 'PX', 3_000).catch(() => undefined);
    }, 1_000);
    this.log.log('Socket.IO gateway ready (redis adapter)');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await new Promise<void>((r) => this.io?.close(() => r()));
    this.pub?.disconnect();
    this.sub?.disconnect();
  }

  private flushBatch(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (!this.batch.length) return;
    const events = this.batch;
    this.batch = [];
    this.io.emit(SOCKET_EVENTS.roundBatch, events);
  }

  private onConnection(socket: Socket): void {
    const principal = socket.data.principal as Principal | null;
    const limiter = new RateLimiter(10);
    this.localConnections++;
    socket.on('disconnect', () => this.localConnections--);
    if (principal) void socket.join(`user:${principal.userId}`);
    void this.readModel.hello(principal).then((hello) => socket.emit(SOCKET_EVENTS.hello, hello));

    socket.on(SOCKET_EVENTS.timePing, (raw: unknown, ack?: Ack) => {
      const s1 = this.clock.now();
      if (typeof ack !== 'function') return;
      const parsed = TimePing.safeParse(raw);
      if (!parsed.success) return;
      ack({ c0: parsed.data.c0, s1, s2: this.clock.now() });
    });

    socket.on(SOCKET_EVENTS.placeBet, (raw: unknown, ack?: Ack) => {
      const receivedAt = this.clock.now();
      if (typeof ack !== 'function') return;
      if (!principal) return ack(fail('UNAUTHENTICATED'));
      if (!limiter.take()) return ack(fail('RATE_LIMITED'));
      const cmd = PlaceBetCommand.safeParse(raw);
      if (!cmd.success) return ack(fail('VALIDATION_ERROR'));
      this.respond(
        this.runner.bus.submit({
          kind: 'bet',
          input: { ...cmd.data, userId: principal.userId, username: principal.username, receivedAt },
        }),
        ack,
      );
    });

    socket.on(SOCKET_EVENTS.cashout, (raw: unknown, ack?: Ack) => {
      const receivedAt = this.clock.now();
      if (typeof ack !== 'function') return;
      if (!principal) return ack(fail('UNAUTHENTICATED'));
      if (!limiter.take()) return ack(fail('RATE_LIMITED'));
      const cmd = CashoutCommand.safeParse(raw);
      if (!cmd.success) return ack(fail('VALIDATION_ERROR'));
      this.respond(this.runner.bus.submit({ kind: 'cashout', input: { ...cmd.data, userId: principal.userId, receivedAt } }), ack);
    });

    socket.on(SOCKET_EVENTS.systemSubscribe, (on: unknown) => {
      void (on ? socket.join('system') : socket.leave('system'));
    });
  }

  private respond(p: Promise<BetResult>, ack: Ack): void {
    p.then(ack, (e: Error) => {
      this.log.error(e.stack ?? e.message);
      ack(fail('NOT_LEADER'));
    });
  }

  /** Live instances from their heartbeats (expired keys = dead instances). */
  async instances(): Promise<InstanceStatus[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${INSTANCE_KEY_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (!keys.length) return [];
    const raw = await this.redis.mget(keys);
    const now = Date.now();
    return raw
      .filter((r): r is string => !!r)
      .map((r) => {
        const s = JSON.parse(r) as Omit<InstanceStatus, 'ageMs'> & { reportedAt: number };
        const { reportedAt, ...rest } = s;
        return { ...rest, ageMs: now - reportedAt };
      })
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }
}
