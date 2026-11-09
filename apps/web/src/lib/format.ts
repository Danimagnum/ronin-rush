import { formatX100 } from '@ronin/shared';
import { CURRENCY } from './config';

const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 123456 cents -> "1,234.56" */
export const money = (cents: number) => nf.format(cents / 100);
export const moneyWithUnit = (cents: number) => `${money(cents)} ${CURRENCY}`;
export const signedMoney = (cents: number) => `${cents >= 0 ? '+' : '−'}${money(Math.abs(cents))}`;
export const mult = (x100: number) => `${formatX100(x100)}×`;

/** Multiplier tier drives colour everywhere (history pills, leaderboard, scene). */
export type Tier = 'low' | 'mid' | 'high' | 'epic';
export const tierOf = (x100: number): Tier => (x100 < 200 ? 'low' : x100 < 500 ? 'mid' : x100 < 1000 ? 'high' : 'epic');
export const tierText: Record<Tier, string> = {
  low: 'text-mist',
  mid: 'text-take',
  high: 'text-kin',
  epic: 'text-plum',
};

export const shortHash = (h: string, n = 10) => `${h.slice(0, n)}…${h.slice(-4)}`;

export const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
