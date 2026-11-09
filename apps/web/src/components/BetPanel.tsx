'use client';
import { GAME_DEFAULTS, payoutFor } from '@ronin/shared';
import { useEffect, useRef, useState } from 'react';
import { liveMultiplier } from './GameStage';
import { CURRENCY } from '@/lib/config';
import { money, mult, signedMoney } from '@/lib/format';
import { commands } from '@/lib/realtime';
import { loadPref, savePref } from '@/lib/session';
import { selectMyBet, useGame } from '@/lib/store';

const CHIPS = [100, 500, 1_000, 5_000, 10_000]; // cents: 1, 5, 10, 50, 100 ryō

const ERRORS: Record<string, string> = {
  BETTING_CLOSED: 'Betting closed for this round. Wait for the next duel.',
  ALREADY_BET: 'You already have a bet in this round.',
  INSUFFICIENT_FUNDS: 'Not enough ryō. Lower the stake or refill your purse.',
  CASHOUT_AFTER_CRASH: 'Too late: the final blow landed before your cash-out reached the server.',
  NOT_RUNNING: 'The duel has not started yet.',
  VALIDATION_ERROR: 'Check the stake and auto cash-out values.',
  RATE_LIMITED: 'Slow down a little.',
  TIMEOUT: 'The server did not answer in time. Your bet list will refresh with the real state.',
  NOT_LEADER: 'The game server is switching over. Try again in a second.',
  UNAUTHENTICATED: 'Sign in or play as a guest first.',
};

export function BetPanel({ onNeedAuth }: { onNeedAuth: () => void }) {
  const user = useGame((s) => s.user);
  const round = useGame((s) => s.round);
  const myBet = useGame(selectMyBet);
  const [amount, setAmount] = useState(1_000);
  const [autoOn, setAutoOn] = useState(false);
  const [autoText, setAutoText] = useState('2.00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setAmount(loadPref('amount', 1_000));
    setAutoOn(loadPref('autoOn', false));
    setAutoText(loadPref('autoText', '2.00'));
  }, []);
  useEffect(() => savePref('amount', amount), [amount]);
  useEffect(() => savePref('autoOn', autoOn), [autoOn]);
  useEffect(() => savePref('autoText', autoText), [autoText]);
  useEffect(() => setError(null), [round?.roundId]);

  const autoX100 = autoOn ? Math.round(parseFloat(autoText) * 100) : null;
  const autoValid = autoX100 === null || (Number.isFinite(autoX100) && autoX100 >= GAME_DEFAULTS.minAutoX100);
  const amountValid = amount >= GAME_DEFAULTS.minBetCents && amount <= GAME_DEFAULTS.maxBetCents && (!user || amount <= user.balance);

  const phase = round?.phase;
  const canBet = !!user && phase === 'BETTING' && !myBet && amountValid && autoValid && !busy;
  const canCashOut = !!user && phase === 'RUNNING' && myBet?.status === 'ACTIVE' && !busy;

  // Live potential payout on the cash-out button.
  useEffect(() => {
    if (!canCashOut || !myBet) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (payoutRef.current) payoutRef.current.textContent = money(payoutFor(myBet.amount, liveMultiplier().x100));
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [canCashOut, myBet]);

  async function act() {
    if (!user) return onNeedAuth();
    setError(null);
    if (canCashOut && round) {
      setBusy(true);
      const res = await commands.cashOut(round.roundId);
      setBusy(false);
      if (!res.ok) setError(ERRORS[res.error] ?? res.error);
    } else if (canBet) {
      setBusy(true);
      const res = await commands.placeBet(amount, autoX100);
      setBusy(false);
      if (!res.ok) setError(ERRORS[res.error] ?? res.error);
    }
  }

  // Space bar is the big button, unless you're typing.
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, button, a, [role="dialog"]')) return;
      e.preventDefault();
      void actRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const button = (() => {
    if (!user) return { label: 'Play as guest', sub: 'or sign in', tone: 'kin' as const, disabled: false };
    if (canCashOut) return { label: 'Cash out', sub: null, tone: 'kin' as const, disabled: false, live: true };
    if (myBet?.status === 'CASHED_OUT')
      return { label: `Cashed out at ${mult(myBet.cashoutX100!)}`, sub: `${signedMoney(myBet.payout! - myBet.amount)} ${CURRENCY}`, tone: 'take' as const, disabled: true };
    if (myBet?.status === 'LOST') return { label: 'Defeated', sub: `−${money(myBet.amount)} ${CURRENCY}`, tone: 'beni' as const, disabled: true };
    if (myBet && phase === 'BETTING')
      return { label: 'Bet placed', sub: myBet.autoX100 ? `auto cash-out at ${mult(myBet.autoX100)}` : 'cash out during the duel', tone: 'take' as const, disabled: true };
    if (phase === 'BETTING') return { label: `Bet ${money(amount)}`, sub: autoX100 && autoValid ? `auto cash-out at ${mult(autoX100)}` : null, tone: 'kin' as const, disabled: !canBet };
    return { label: 'Duel in progress', sub: 'bets open when it ends', tone: 'mist' as const, disabled: true };
  })();

  const lockedInputs = !!myBet || phase === 'RUNNING';
  const toneClass = {
    kin: 'bg-kin text-ai-950 hover:bg-[#e2bf72] disabled:bg-kin/40 disabled:text-ai-950/60',
    take: 'bg-take/15 text-take ring-1 ring-take/40',
    beni: 'bg-beni/15 text-[#e07383] ring-1 ring-beni/40',
    mist: 'bg-ai-700 text-mist',
  }[button.tone];

  return (
    <section aria-label="Bet" className="rounded-[var(--radius-panel)] bg-ai-800 p-4 sm:p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_auto_minmax(220px,280px)] md:items-end">
        <div>
          <label htmlFor="stake" className="text-sm text-mist">
            Stake
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative flex-1">
              <input
                id="stake"
                inputMode="decimal"
                disabled={lockedInputs}
                value={money(amount).replace(/,/g, '')}
                onChange={(e) => {
                  const v = Math.round(parseFloat(e.target.value || '0') * 100);
                  if (Number.isFinite(v)) setAmount(Math.max(0, Math.min(GAME_DEFAULTS.maxBetCents, v)));
                }}
                className="tabular w-full rounded-lg bg-ai-950 py-2.5 pr-12 pl-3 text-lg text-washi ring-1 ring-ai-600 outline-none focus:ring-kin disabled:opacity-60"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-mist">{CURRENCY}</span>
            </div>
            <button type="button" disabled={lockedInputs} onClick={() => setAmount((a) => Math.max(GAME_DEFAULTS.minBetCents, Math.floor(a / 2)))} className="rounded-lg bg-ai-700 px-3 py-2.5 text-sm hover:bg-ai-600 disabled:opacity-40">
              ½
            </button>
            <button type="button" disabled={lockedInputs} onClick={() => setAmount((a) => Math.min(GAME_DEFAULTS.maxBetCents, a * 2))} className="rounded-lg bg-ai-700 px-3 py-2.5 text-sm hover:bg-ai-600 disabled:opacity-40">
              2×
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Add to stake">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={lockedInputs}
                onClick={() => setAmount((a) => Math.min(GAME_DEFAULTS.maxBetCents, a + c))}
                className="tabular rounded-[var(--radius-chip)] border border-kin/35 px-3 py-1 text-sm text-kin hover:border-kin hover:bg-kin/10 disabled:opacity-40"
              >
                +{c / 100}
              </button>
            ))}
            <button type="button" disabled={lockedInputs} onClick={() => setAmount(GAME_DEFAULTS.minBetCents)} className="rounded-[var(--radius-chip)] px-3 py-1 text-sm text-mist hover:text-washi disabled:opacity-40">
              Reset
            </button>
          </div>
        </div>

        <div className="md:w-40">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="auto" className="text-sm text-mist">
              Auto cash-out
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={autoOn}
              aria-label="Enable auto cash-out"
              disabled={lockedInputs}
              onClick={() => setAutoOn((v) => !v)}
              className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${autoOn ? 'bg-kin' : 'bg-ai-600'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-washi transition-transform ${autoOn ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </button>
          </div>
          <div className="relative mt-1.5">
            <input
              id="auto"
              inputMode="decimal"
              disabled={!autoOn || lockedInputs}
              value={autoText}
              onChange={(e) => setAutoText(e.target.value.replace(/[^0-9.]/g, ''))}
              onBlur={() => {
                const v = parseFloat(autoText);
                setAutoText(Number.isFinite(v) ? Math.max(1.01, v).toFixed(2) : '2.00');
              }}
              aria-invalid={!autoValid}
              className="tabular w-full rounded-lg bg-ai-950 py-2.5 pr-8 pl-3 text-lg ring-1 ring-ai-600 outline-none focus:ring-kin disabled:opacity-40 aria-[invalid=true]:ring-beni"
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-mist">×</span>
          </div>
          <p className="mt-2 text-xs leading-snug text-mist">The server cashes you out at exactly this multiplier.</p>
        </div>

        <div>
          <button
            type="button"
            onClick={() => void act()}
            disabled={button.disabled || busy}
            className={`flex min-h-[76px] w-full flex-col items-center justify-center rounded-xl px-4 py-3 text-center transition-colors ${toneClass}`}
          >
            <span className="font-display text-2xl font-extrabold">
              {button.label}
              {button.live && myBet ? (
                <>
                  {' '}
                  <span ref={payoutRef} className="tabular">
                    {money(myBet.amount)}
                  </span>
                </>
              ) : null}
            </span>
            {button.sub ? <span className="mt-0.5 text-sm opacity-80">{button.sub}</span> : null}
          </button>
          <p className="mt-2 hidden text-center text-xs text-mist sm:block">
            Press <kbd className="rounded bg-ai-700 px-1.5 py-0.5 text-washi">Space</kbd> to {canCashOut ? 'cash out' : 'bet'}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-beni/10 px-3 py-2 text-sm text-[#e8909c]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
