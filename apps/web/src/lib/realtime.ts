'use client';
import { SOCKET_EVENTS, type CommandError, type PublicBet, type RoundEvent, type ServerHello, type SystemMetrics, type TimePong } from '@ronin/shared';
import { io, type Socket } from 'socket.io-client';
import { clock } from './clock';
import { API_URL } from './config';
import { useGame } from './store';

export type BetAck = { ok: true; bet: PublicBet; balance?: number | null } | { ok: false; error: CommandError };

let socket: Socket | null = null;
let pingTimer: ReturnType<typeof setTimeout> | null = null;

/** Opens (or re-opens with a new token) the game socket and keeps the clock in sync. */
export function connect(token: string | null): void {
  disconnect();
  const store = useGame.getState();
  store.set({ connection: 'connecting' });

  const opts = { transports: ['websocket', 'polling'], auth: token ? { token } : {}, reconnectionDelayMax: 4_000 };
  socket = API_URL ? io(API_URL, opts) : io(opts); // empty URL: same origin, through the reverse proxy
  socket.on('connect', () => {
    useGame.getState().set({ connection: 'online' });
    // Re-join the metrics room after a reconnect if the System view is open.
    if (useGame.getState().systemView) socket?.emit(SOCKET_EVENTS.systemSubscribe, true);
    void syncBurst();
  });
  socket.on(SOCKET_EVENTS.systemMetrics, (m: SystemMetrics) => useGame.getState().applySystem(m));
  socket.on('disconnect', () => useGame.getState().set({ connection: 'offline' }));
  socket.on(SOCKET_EVENTS.hello, (h: ServerHello) => useGame.getState().applyHello(h));
  socket.on(SOCKET_EVENTS.roundEvent, (e: RoundEvent) => useGame.getState().applyEvent(e));
  socket.on(SOCKET_EVENTS.roundBatch, (events: RoundEvent[]) => {
    const { applyEvent } = useGame.getState();
    for (const e of events) applyEvent(e);
  });
  socket.on(SOCKET_EVENTS.balance, (b: { balance: number }) => useGame.getState().setBalance(b.balance));
  socket.on(SOCKET_EVENTS.authExpired, () => useGame.getState().set({ sessionExpired: true }));
}

export function disconnect(): void {
  if (pingTimer) clearTimeout(pingTimer);
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}

function ping(): Promise<void> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve();
    const c0 = clock.localNow();
    socket.timeout(3_000).emit(SOCKET_EVENTS.timePing, { c0 }, (err: unknown, pong: TimePong) => {
      if (!err && pong) {
        clock.addSample(pong.c0, pong.s1, pong.s2, clock.localNow());
        useGame.getState().set({ latencyMs: Math.round(clock.rtt), offsetMs: clock.offset });
      }
      resolve();
    });
  });
}

/** 8 quick samples on connect, then one every 5 s to track drift. */
async function syncBurst(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ping();
    await new Promise((r) => setTimeout(r, 60));
  }
  const loop = () => {
    pingTimer = setTimeout(async () => {
      await ping();
      loop();
    }, 5_000);
  };
  loop();
}

function command<T>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, error: 'TIMEOUT' } as T);
    socket.timeout(5_000).emit(event, payload, (err: unknown, res: T) => resolve(err ? ({ ok: false, error: 'TIMEOUT' } as T) : res));
  });
}

const key = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 32);

export const commands = {
  placeBet: (amount: number, autoX100: number | null) => command<BetAck>(SOCKET_EVENTS.placeBet, { amount, autoX100, idempotencyKey: key() }),
  /** No multiplier is sent: the server decides it from the moment it received this message. */
  cashOut: (roundId: number) => command<BetAck>(SOCKET_EVENTS.cashout, { roundId, idempotencyKey: key() }),
  subscribeSystem: (on: boolean) => socket?.emit(SOCKET_EVENTS.systemSubscribe, on),
  /** Swaps the socket's token for a renewed one; the round and any bet carry on. */
  renewAuth: async (token: string) => {
    const res = await command<{ ok: true; expiresAt: number | null } | { ok: false; error: CommandError }>(SOCKET_EVENTS.authRenew, { token });
    if (res.ok) useGame.getState().set({ token, sessionExpiresAt: res.expiresAt, sessionExpired: false });
    return res;
  },
};
