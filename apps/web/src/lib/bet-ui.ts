'use client';
import { create } from 'zustand';
import { loadPref, savePref } from './session';

/**
 * The bet form lives in a small store of its own because it is drawn in two places: the stake and
 * auto cash-out controls, and the action button that stays under the player's thumb on phones.
 */
interface BetUi {
  amount: number; // cents
  autoOn: boolean;
  autoText: string;
  busy: boolean;
  error: string | null;
  hydrated: boolean;
  hydrate: () => void;
  patch: (p: Partial<Pick<BetUi, 'amount' | 'autoOn' | 'autoText' | 'busy' | 'error'>>) => void;
}

export const useBetUi = create<BetUi>((set, get) => ({
  amount: 1_000,
  autoOn: false,
  autoText: '2.00',
  busy: false,
  error: null,
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    set({ amount: loadPref('amount', 1_000), autoOn: loadPref('autoOn', false), autoText: loadPref('autoText', '2.00'), hydrated: true });
  },
  patch: (p) => {
    set(p);
    if (p.amount !== undefined) savePref('amount', p.amount);
    if (p.autoOn !== undefined) savePref('autoOn', p.autoOn);
    if (p.autoText !== undefined) savePref('autoText', p.autoText);
  },
}));

/** A short buzz on the phones that support it: the bet landed, the cash-out landed. */
export function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not available */
  }
}
