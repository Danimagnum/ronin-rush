/**
 * Multiplier curve m(t) = e^(k·t), t in milliseconds since the round started.
 *
 * Multipliers are handled as integers x100 (341 = 3.41x) everywhere money is involved;
 * floats only exist for animation.
 */

/** ≈ 2.00x at 11.6 s, 5.00x at 26.8 s, 10.00x at 38.4 s, 100x at 76.8 s. */
export const DEFAULT_GROWTH_PER_MS = 0.00006;

// exp(ln(2)) can come out as 1.9999999999999998; nudge before flooring so that at
// exactly t(x) the displayed multiplier is x and never x - 0.01.
const FLOOR_EPSILON = 1e-9;

export function multiplierAt(elapsedMs: number, k = DEFAULT_GROWTH_PER_MS): number {
  return elapsedMs <= 0 ? 1 : Math.exp(k * elapsedMs);
}

export function multiplierX100At(elapsedMs: number, k = DEFAULT_GROWTH_PER_MS): number {
  return Math.max(100, Math.floor(multiplierAt(elapsedMs, k) * 100 + FLOOR_EPSILON));
}

/** Inverse of the curve: ms after start at which the multiplier reaches x100. */
export function elapsedMsForX100(x100: number, k = DEFAULT_GROWTH_PER_MS): number {
  if (x100 <= 100) return 0;
  return Math.log(x100 / 100) / k;
}

export type CashoutRejection = 'NOT_RUNNING' | 'CASHOUT_AFTER_CRASH';

export type CashoutDecision = { ok: true; x100: number } | { ok: false; reason: CashoutRejection };

/**
 * The single rule that decides a manual cash-out. Pure, so it is unit-tested in isolation
 * and shared by the round engine.
 *
 * - `receivedAt` is the server timestamp taken when the request hit the socket, not when it
 *   was processed, and never anything the client sent.
 * - Accepted iff startedAt <= receivedAt < crashAt.
 * - Pays floor(m(receivedAt - startedAt)), clamped to [1.00x, crash - 0.01x] so float error
 *   can never pay the crash point itself.
 */
export function decideCashout(params: {
  receivedAt: number;
  startedAt: number;
  crashAt: number;
  crashX100: number;
  k: number;
}): CashoutDecision {
  const { receivedAt, startedAt, crashAt, crashX100, k } = params;
  if (receivedAt < startedAt) return { ok: false, reason: 'NOT_RUNNING' };
  if (receivedAt >= crashAt) return { ok: false, reason: 'CASHOUT_AFTER_CRASH' };
  const x100 = Math.min(multiplierX100At(receivedAt - startedAt, k), crashX100 - 1);
  return { ok: true, x100: Math.max(100, x100) };
}

/** Auto cash-out at `autoX100` wins iff it is strictly below the crash point; it then pays exactly autoX100. */
export function autoCashoutWins(autoX100: number, crashX100: number): boolean {
  return autoX100 < crashX100;
}

/** payout = floor(stake · x100 / 100), in integer cents. */
export function payoutFor(stakeCents: number, x100: number): number {
  return Math.floor((stakeCents * x100) / 100);
}
