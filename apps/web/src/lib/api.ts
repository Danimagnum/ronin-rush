import type { PublicConfig, SessionUser, SettledRoundSummary } from '@ronin/shared';
import { API_URL } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data && (data.message as string)) || res.statusText);
  return data as T;
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
}

export interface MyBet {
  betId: string;
  roundId: number;
  amount: number;
  autoX100: number | null;
  status: 'ACTIVE' | 'CASHED_OUT' | 'LOST';
  cashoutX100: number | null;
  payout: number | null;
  autoCashout: boolean | null;
  crashX100: number | null;
  createdAt: string;
}

export interface LeaderboardEntry {
  userId: string;
  username: string;
  isBot: boolean;
  value: number;
}

export interface Fairness {
  commitment: string;
  publicSalt: string;
  chainLength: number;
  hash: string;
  formula: string;
  recentRounds: SettledRoundSummary[];
}

export const api = {
  guest: () => request<AuthResponse>('/api/auth/guest', { method: 'POST' }),
  login: (username: string, password: string) => request<AuthResponse>('/api/auth/login', { method: 'POST', body: { username, password } }),
  register: (username: string, password: string) =>
    request<AuthResponse>('/api/auth/register', { method: 'POST', body: { username, password } }),
  me: (token: string) => request<SessionUser>('/api/me', { token }),
  myBets: (token: string) => request<MyBet[]>('/api/me/bets?limit=100', { token }),
  refill: (token: string) => request<{ balance: number }>('/api/me/refill', { method: 'POST', token }),
  fairness: () => request<Fairness>('/api/fairness'),
  config: () => request<PublicConfig>('/api/config'),
  leaderboard: () =>
    request<{ date: string; bestMultiplier: LeaderboardEntry[]; biggestWin: LeaderboardEntry[] }>('/api/leaderboard'),
};
