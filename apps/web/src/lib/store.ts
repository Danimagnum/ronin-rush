'use client';
import type { PublicBet, RoundEvent, RoundPhase, RoundSnapshot, ServerHello, SessionUser, SettledRoundSummary } from '@ronin/shared';
import { create } from 'zustand';

export interface RoundView {
  roundId: number;
  phase: RoundPhase;
  seedHash: string;
  bettingEndsAt: number;
  startedAt: number | null;
  crashX100: number | null;
  crashedAt: number | null;
  k: number;
}

export interface GameState {
  connection: 'connecting' | 'online' | 'offline';
  instanceId: string | null;
  latencyMs: number | null;
  offsetMs: number;
  user: SessionUser | null;
  token: string | null;
  round: RoundView | null;
  bets: Record<string, PublicBet>;
  history: SettledRoundSummary[];
  lastSettled: { roundId: number; seed: string; crashX100: number } | null;
  fairness: { commitment: string; publicSalt: string } | null;
  sound: boolean;
  systemView: boolean;
  sessionStartedAt: number;

  applyHello: (h: ServerHello) => void;
  applyEvent: (e: RoundEvent) => void;
  setBalance: (balance: number) => void;
  setAuth: (token: string | null, user: SessionUser | null) => void;
  set: (patch: Partial<GameState>) => void;
}

const fromSnapshot = (s: RoundSnapshot): RoundView => ({
  roundId: s.roundId,
  phase: s.phase,
  seedHash: s.seedHash,
  bettingEndsAt: s.bettingEndsAt,
  startedAt: s.startedAt,
  crashX100: s.crashX100,
  crashedAt: s.crashedAt,
  k: s.k,
});

export const useGame = create<GameState>((set, get) => ({
  connection: 'connecting',
  instanceId: null,
  latencyMs: null,
  offsetMs: 0,
  user: null,
  token: null,
  round: null,
  bets: {},
  history: [],
  lastSettled: null,
  fairness: null,
  sound: false,
  systemView: false,
  sessionStartedAt: Date.now(),

  applyHello: (h) =>
    set({
      instanceId: h.instanceId,
      round: h.snapshot ? fromSnapshot(h.snapshot) : null,
      bets: Object.fromEntries((h.snapshot?.bets ?? []).map((b) => [b.betId, b])),
      history: h.history,
      fairness: h.fairness,
      user: h.user ?? get().user,
    }),

  applyEvent: (e) => {
    const s = get();
    switch (e.type) {
      case 'round.betting':
        set({
          round: { roundId: e.roundId, phase: 'BETTING', seedHash: e.seedHash, bettingEndsAt: e.bettingEndsAt, startedAt: null, crashX100: null, crashedAt: null, k: s.round?.k ?? 0.00006 },
          bets: {},
        });
        break;
      case 'round.started':
        if (s.round?.roundId === e.roundId) set({ round: { ...s.round, phase: 'RUNNING', startedAt: e.startedAt, k: e.k } });
        break;
      case 'round.crashed':
        if (s.round?.roundId === e.roundId) set({ round: { ...s.round, phase: 'CRASHED', crashX100: e.crashX100, crashedAt: e.crashedAt } });
        break;
      case 'round.settled': {
        const seedHash = s.round?.roundId === e.roundId ? s.round.seedHash : '';
        set({
          round: s.round?.roundId === e.roundId ? { ...s.round, phase: 'SETTLED', crashX100: e.crashX100 } : s.round,
          history: [{ roundId: e.roundId, crashX100: e.crashX100, seed: e.seed, seedHash, settledAt: e.settledAt }, ...s.history.filter((h) => h.roundId !== e.roundId)].slice(0, 50),
          lastSettled: { roundId: e.roundId, seed: e.seed, crashX100: e.crashX100 },
        });
        break;
      }
      case 'bet.placed':
      case 'bet.cashed_out':
        if (s.round && e.bet.roundId === s.round.roundId) set({ bets: { ...s.bets, [e.bet.betId]: e.bet } });
        break;
      case 'bets.lost': {
        const bets = { ...s.bets };
        for (const id of e.betIds) if (bets[id]) bets[id] = { ...bets[id]!, status: 'LOST', payout: 0 };
        set({ bets });
        break;
      }
    }
  },

  setBalance: (balance) => {
    const u = get().user;
    if (u) set({ user: { ...u, balance } });
  },
  setAuth: (token, user) => set({ token, user }),
  set: (patch) => set(patch),
}));

/** The signed-in player's bet in the current round, if any. */
export const selectMyBet = (s: GameState): PublicBet | null => {
  if (!s.user) return null;
  for (const b of Object.values(s.bets)) if (b.userId === s.user.id) return b;
  return null;
};
