import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import { CashoutCommand, PlaceBetCommand, SOCKET_EVENTS, TimePing, type CommandError } from '@ronin/shared';
import type Redis from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { AuthService, type Principal } from '../auth/auth.service';
import type { Clock } from '../clock/clock';
import type { Env } from '../config/env';
import { CLOCK, ENV, REDIS } from '../config/tokens';
import { EventHub } from '../round/event-hub';
import { RoundRunner } from '../round/round-runner.service';
import type { BetResult } from '../round/round-engine';
import { PostgresLedger } from '../wallet/postgres-ledger';
import { ReadModel } from './read-model.service';

type Ack = (payload: unknown) => void;

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
    private readonly ledger: PostgresLedger,
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
    this.io.adapter(createAdapter(this.pub, this.sub, { key: 'ronin:sio' }));

    this.io.use(async (socket, next) => {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      socket.data.principal = await this.auth.verify(token).catch(() => null);
      next();
    });
    this.io.on('connection', (socket) => this.onConnection(socket));

    // Leader-side fan-out: one emit, delivered cluster-wide by the adapter.
    this.hub.subscribe((e) => {
      if (!this.runner.isLeader) return;
      this.io.emit(SOCKET_EVENTS.roundEvent, e);
      if ((e.type === 'bet.placed' || e.type === 'bet.cashed_out') && !e.bet.isBot) void this.pushBalance(e.bet.userId);
    });

    this.heartbeat = setInterval(() => {
      void this.redis.set(`ronin:conn:${this.env.INSTANCE_ID}`, String(this.localConnections), 'PX', 3_000).catch(() => undefined);
    }, 1_000);
    this.log.log('Socket.IO gateway ready (redis adapter)');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await new Promise<void>((r) => this.io?.close(() => r()));
    this.pub?.disconnect();
    this.sub?.disconnect();
  }

  private async pushBalance(userId: string): Promise<void> {
    const balance = await this.ledger.balanceOf(userId);
    this.io.to(`user:${userId}`).emit(SOCKET_EVENTS.balance, { balance });
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

  /** Total sockets across the cluster, from per-instance heartbeats. */
  async totalConnections(): Promise<{ total: number; perInstance: Record<string, number> }> {
    const keys = await this.redis.keys('ronin:conn:*');
    const values = keys.length ? await this.redis.mget(keys) : [];
    const perInstance = Object.fromEntries(keys.map((k, i) => [k.slice('ronin:conn:'.length), Number(values[i] ?? 0)]));
    return { total: Object.values(perInstance).reduce((a, b) => a + b, 0), perInstance };
  }
}
