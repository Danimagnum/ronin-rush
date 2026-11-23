'use client';
import { GAME_DEFAULTS, payoutFor } from '@ronin/shared';
import { useEffect, useRef, useState } from 'react';
import { liveMultiplier } from './GameStage';
import { CURRENCY } from '@/lib/config';
import { buzz, useBetUi } from '@/lib/bet-ui';
import { duration, money, mult, signedMoney } from '@/lib/format';
import { commands } from '@/lib/realtime';
import { selectMyBet, useGame } from '@/lib/store';
import { useShell } from './AppShell';

const CHIPS = [100, 500, 1_000, 5_000, 10_000]; // cents: 1, 5, 10, 50, 100 ryō

const ERRORS: Record<string, string> = {
  BETTING_CLOSED: 'Betting closed for this round. Wait for the next duel.',
  ALREADY_BET: 'You already have a bet in this round.',
  INSUFFICIENT_FUNDS: 'Not enough ryō. Lower the stake or refill your purse.',
  RESPONSIBLE_GAMING_BLOCKED: 'Your platform account limits or status do not allow this stake.',
  WALLET_UNAVAILABLE: 'The wallet is unreachable right now. Nothing was charged; try again.',
  CASHOUT_AFTER_CRASH: 'Too late: the final blow landed before your cash-out reached the server.',
  NOT_RUNNING: 'The duel has not started yet.',
  VALIDATION_ERROR: 'Check the stake and auto cash-out values.',
  RATE_LIMITED: 'Slow down a little.',
  TIMEOUT: 'The server did not answer in time. Your bet list will refresh with the real state.',
  NOT_LEADER: 'The game server is switching over. Try again in a second.',
  UNAUTHENTICATED: 'Sign in or play as a guest first.',
  AUTH_EXPIRED: 'Your platform session expired. It renews on its own while the portal is open; otherwise reopen the game from the portal.',
  IDENTITY_MISMATCH: 'The portal sent a token for a different player. Reopen the game from the portal.',
};

/** Everything the two halves of the bet UI need to agree on. */
function useBetState() {
  const user = useGame((s) => s.user);
  const round = useGame((s) => s.round);
  const myBet = useGame(selectMyBet);
  const breakUntil = useGame((s) => s.breakUntil);
  const { amount, autoOn, autoText } = useBetUi();
  const autoX100 = autoOn ? Math.round(parseFloat(autoText) * 100) : null;
  const autoValid = autoX100 === null || (Number.isFinite(autoX100) && autoX100 >= GAME_DEFAULTS.minAutoX100);
  const amountValid = amount >= GAME_DEFAULTS.minBetCents && amount <= GAME_DEFAULTS.maxBetCents && (!user || amount <= user.balance);
  const lockedInputs = !!myBet || round?.phase === 'RUNNING';
  return { user, round, myBet, breakUntil, amount, autoOn, autoText, autoX100, autoValid, amountValid, lockedInputs };
}

/** Stake on a strip of washi, koban coins to add to it, and the auto cash-out. */
export function StakeControls() {
  const { amount, autoOn, autoText, autoValid, lockedInputs } = useBetState();
  const patch = useBetUi((s) => s.patch);
  const hydrate = useBetUi((s) => s.hydrate);
  const round = useGame((s) => s.round);
  useEffect(() => hydrate(), [hydrate]);
  useEffect(() => patch({ error: null }), [round?.roundId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (cents: number) => patch({ amount: Math.max(0, Math.min(GAME_DEFAULTS.maxBetCents, cents)) });

  return (
    <section aria-label="Bet" className="min-w-0 pt-1">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-3 md:grid-cols-[minmax(0,1fr)_170px]">
        <div className="min-w-0">
          <label htmlFor="stake" className="text-sm font-medium text-washi/80">
            Stake
          </label>
          <div className="mt-1.5 flex items-stretch gap-2">
            <div className="slip cut relative min-w-0 flex-1" aria-disabled={lockedInputs}>
              <input
                id="stake"
                name="stake"
                autoComplete="off"
                spellCheck={false}
                inputMode="decimal"
                disabled={lockedInputs}
                value={money(amount).replace(/,/g, '')}
                onChange={(e) => {
                  const v = Math.round(parseFloat(e.target.value || '0') * 100);
                  if (Number.isFinite(v)) set(v);
                }}
                className="tabular h-14 w-full bg-transparent pr-14 pl-4 font-display text-3xl font-extrabold outline-none disabled:opacity-70"
              />
              <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-sm font-bold opacity-70">{CURRENCY}</span>
            </div>
            <button type="button" disabled={lockedInputs} onClick={() => set(Math.max(GAME_DEFAULTS.minBetCents, Math.floor(amount / 2)))} aria-label="Halve the stake" className="cut-sm btn-flick w-12 shrink-0 bg-ai-700 font-display text-lg font-bold hover:bg-ai-600 disabled:opacity-40">
              ½
            </button>
            <button type="button" disabled={lockedInputs} onClick={() => set(Math.min(GAME_DEFAULTS.maxBetCents, amount * 2))} aria-label="Double the stake" className="cut-sm btn-flick w-12 shrink-0 bg-ai-700 font-display text-lg font-bold hover:bg-ai-600 disabled:opacity-40">
              2×
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label="Add to stake">
            {CHIPS.map((c) => (
              <button key={c} type="button" disabled={lockedInputs} onClick={() => set(amount + c)} className="koban tabular shrink-0" aria-label={`Add ${c / 100} ${CURRENCY}`}>
                +{c / 100}
              </button>
            ))}
            <button type="button" disabled={lockedInputs} onClick={() => set(GAME_DEFAULTS.minBetCents)} className="shrink-0 px-3 py-2 text-sm text-washi/75 hover:text-washi disabled:opacity-40">
              Clear
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 md:block">
          <div className="flex items-center justify-between gap-3 md:gap-2">
            <label htmlFor="auto" className="text-sm font-medium text-washi/80">
              Auto cash-out
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={autoOn}
              aria-label="Enable auto cash-out"
              disabled={lockedInputs}
              onClick={() => patch({ autoOn: !autoOn })}
              className={`relative h-7 w-12 shrink-0 disabled:opacity-40 ${autoOn ? 'bg-kin' : 'bg-ai-600'}`}
            >
              <span className={`absolute top-1 left-0 h-5 w-5 transition-transform ${autoOn ? 'translate-x-6 bg-sumi' : 'translate-x-1 bg-washi'}`} />
            </button>
          </div>
          <div className="slip cut relative w-36 shrink-0 md:mt-1.5 md:w-auto" aria-disabled={!autoOn || lockedInputs}>
            <input
              id="auto"
              name="auto-cashout"
              autoComplete="off"
              spellCheck={false}
              inputMode="decimal"
              disabled={!autoOn || lockedInputs}
              value={autoText}
              onChange={(e) => patch({ autoText: e.target.value.replace(/[^0-9.]/g, '') })}
              onBlur={() => {
                const v = parseFloat(autoText);
                patch({ autoText: Number.isFinite(v) ? Math.max(1.01, v).toFixed(2) : '2.00' });
              }}
              aria-invalid={!autoValid}
              className="tabular h-12 w-full bg-transparent pr-9 pl-4 font-display text-2xl md:h-14 md:text-3xl font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:text-beni"
            />
            <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-lg font-bold opacity-70">×</span>
          </div>
          <p className="mt-1.5 hidden text-xs leading-snug text-washi/65 md:block">The server cashes you out at exactly this multiplier.</p>
        </div>
      </div>
    </section>
  );
}

/** The one button. Paper while betting, gold and beating while a cash-out is possible. */
export function ActionDock() {
  const { user, round, myBet, breakUntil, amount, autoX100, autoValid, amountValid } = useBetState();
  const platformMode = useGame((s) => s.platformMode);
  const sessionExpired = useGame((s) => s.sessionExpired);
  const { busy, error } = useBetUi();
  const patch = useBetUi((s) => s.patch);
  const { requestAuth } = useShell();
  const payoutRef = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const resting = breakUntil > now;
  useEffect(() => {
    if (breakUntil <= Date.now()) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [breakUntil]);

  const phase = round?.phase;
  const canBet = !!user && phase === 'BETTING' && !myBet && amountValid && autoValid && !busy && !resting;
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

  // The beat of the button follows the duel's tier.
  const [tier, setTier] = useState(0);
  useEffect(() => {
    if (!canCashOut) return;
    const t = setInterval(() => {
      const x = liveMultiplier().x100;
      setTier(x >= 500 ? 2 : x >= 200 ? 1 : 0);
    }, 150);
    return () => clearInterval(t);
  }, [canCashOut]);

  async function act() {
    if (!user) return platformMode ? undefined : requestAuth();
    if (sessionExpired) return patch({ error: ERRORS.AUTH_EXPIRED! });
    patch({ error: null });
    if (canCashOut && round) {
      patch({ busy: true });
      const res = await commands.cashOut(round.roundId);
      patch({ busy: false, error: res.ok ? null : (ERRORS[res.error] ?? res.error) });
      if (res.ok) buzz(35);
    } else if (canBet) {
      patch({ busy: true });
      const res = await commands.placeBet(amount, autoX100);
      patch({ busy: false, error: res.ok ? null : (ERRORS[res.error] ?? res.error) });
      if (res.ok) buzz(15);
    }
  }

  // Space bar is the big button, unless you're typing.
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, button, a, [role="dialog"], dialog')) return;
      e.preventDefault();
      void actRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  type Tone = 'cash' | 'bet' | 'won' | 'lost' | 'wait';
  const button = ((): { label: string; sub: string | null; tone: Tone; disabled: boolean; live?: boolean } => {
    if (!user && platformMode) return { label: 'Sign in on the platform', sub: 'open Ronin Rush from your portal', tone: 'wait', disabled: true };
    if (!user) return { label: 'Enter the dojo', sub: 'play as a guest or sign in', tone: 'bet', disabled: false };
    if (sessionExpired && !myBet?.autoX100) return { label: 'Session expired', sub: 'waiting for the portal to renew it', tone: 'wait', disabled: true };
    if (canCashOut) return { label: 'Cash out', sub: null, tone: 'cash', disabled: false, live: true };
    if (myBet?.status === 'CASHED_OUT') return { label: `Cashed out at ${mult(myBet.cashoutX100!)}`, sub: `${signedMoney(myBet.payout! - myBet.amount)} ${CURRENCY}`, tone: 'won', disabled: true };
    if (myBet?.status === 'LOST') return { label: 'Defeated', sub: `−${money(myBet.amount)} ${CURRENCY}`, tone: 'lost', disabled: true };
    if (myBet && phase === 'BETTING') return { label: 'Bet placed', sub: myBet.autoX100 ? `auto cash-out at ${mult(myBet.autoX100)}` : 'cash out during the duel', tone: 'won', disabled: true };
    if (resting && phase === 'BETTING') return { label: 'On a break', sub: `new bets are paused for ${duration(breakUntil - now)}`, tone: 'wait', disabled: true };
    if (phase === 'BETTING') return { label: `Bet ${money(amount)}`, sub: autoX100 && autoValid ? `auto cash-out at ${mult(autoX100)}` : null, tone: 'bet', disabled: !canBet };
    return { label: 'Duel in progress', sub: 'bets open when it ends', tone: 'wait', disabled: true };
  })();

  return (
    <div className="max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-3 max-md:border-t-[6px] max-md:border-hinoki max-md:bg-ai-950 max-md:px-3 max-md:pt-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] md:self-end">
      {error ? (
        <p role="alert" className="cut-sm mb-2 bg-beni/15 px-3 py-2 text-sm text-beni-soft">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void act()}
        disabled={button.disabled || busy}
        data-tone={button.tone}
        data-tier={tier}
        className="act cut btn-flick flex w-full flex-col items-center justify-center px-4 py-3 text-center"
      >
        {button.live && myBet ? (
          <>
            <span className="font-display text-xl font-extrabold">Cash out</span>
            <span className="tabular font-display text-3xl leading-none font-extrabold">
              <span ref={payoutRef}>{money(myBet.amount)}</span> <span className="text-base">{CURRENCY}</span>
            </span>
          </>
        ) : (
          <>
            <span className="font-display text-2xl leading-tight font-extrabold">{button.label}</span>
            {button.sub ? <span className="mt-0.5 text-sm opacity-85">{button.sub}</span> : null}
          </>
        )}
      </button>
      <p className={`mt-2 hidden text-center text-xs text-washi/65 md:block ${button.disabled && !canCashOut ? 'invisible' : ''}`}>
        Press <kbd className="bg-ai-700 px-1.5 py-0.5 text-washi">Space</kbd> to {canCashOut ? 'cash out' : 'bet'}
      </p>
    </div>
  );
}
