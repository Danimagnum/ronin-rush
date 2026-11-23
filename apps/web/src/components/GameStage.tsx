'use client';
import { formatX100, multiplierAt, multiplierX100At } from '@ronin/shared';
import { useEffect, useRef, useState } from 'react';
import type { DuelAudio } from '@/game/audio';
import type { FightScene, SceneFrame } from '@/game/scene';
import { clock } from '@/lib/clock';
import { useShell } from './AppShell';
import { CURRENCY } from '@/lib/config';
import { money, mult, signedMoney } from '@/lib/format';
import { selectMyBet, useGame } from '@/lib/store';

/** Live multiplier from the server's startedAt and our synced clock. Never sent anywhere. */
export function liveMultiplier(): { x: number; x100: number } {
  const r = useGame.getState().round;
  if (!r || r.phase !== 'RUNNING' || r.startedAt === null) return { x: 1, x100: 100 };
  const elapsed = clock.serverNow() - r.startedAt;
  return { x: multiplierAt(elapsed, r.k), x100: multiplierX100At(elapsed, r.k) };
}

export function GameStage({ audio }: { audio: DuelAudio }) {
  const effects = useGame((s) => s.effects);
  const phase = useGame((s) => s.round?.phase);
  const roundId = useGame((s) => s.round?.roundId);
  const crashX100 = useGame((s) => s.round?.crashX100);
  const myBet = useGame(selectMyBet);
  const user = useGame((s) => s.user);
  const platformMode = useGame((s) => s.platformMode);
  const { requestAuth } = useShell();
  const incenseRef = useRef<HTMLDivElement>(null);
  const emberRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const bigRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);
  const signBeforeRef = useRef<HTMLSpanElement>(null);
  const signAfterRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FightScene | null>(null);

  // Mount the Pixi scene once; it pulls state every frame, React never re-renders it.
  useEffect(() => {
    let disposed = false;
    const el = host.current!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPower = effects === 'low' || window.matchMedia('(max-width: 640px)').matches || (navigator.hardwareConcurrency ?? 8) <= 4;
    // Pixel-art stage by default (one pixel grid for sprites and backdrop, ~9x fewer pixels to
    // fill); `?pixel=0` keeps the smooth high-resolution backdrop behind the sprites.
    const pixelArt = new URLSearchParams(window.location.search).get('pixel') !== '0';
    const frame = (): SceneFrame => {
      const r = useGame.getState().round;
      return {
        phase: r?.phase ?? 'IDLE',
        roundId: r?.roundId ?? 0,
        multiplier: liveMultiplier().x,
        msSinceCrash: r?.crashedAt != null ? clock.serverNow() - r.crashedAt : null,
      };
    };
    void import('@/game/scene').then(async ({ FightScene }) => {
      const scene = await FightScene.create(el, frame, { onClash: (i) => audio.clash(i), onFinalBlow: () => audio.finalBlow() }, { reducedMotion, lowPower, pixelArt });
      if (disposed) scene.destroy();
      else {
        sceneRef.current = scene;
        // Exposed for the System view and performance checks (fps, quality level).
        (window as unknown as { __roninScene?: FightScene }).__roninScene = scene;
      }
    });
    return () => {
      disposed = true;
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, [audio, effects]);

  // Overlay text: updated imperatively at display rate.
  useEffect(() => {
    let raf = 0;
    let lastTier = -2;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = useGame.getState().round;
      const big = bigRef.current!;
      const label = labelRef.current!;
      const stick = incenseRef.current!;
      const ember = emberRef.current!;
      const burn = (f: number) => {
        stick.style.transform = `scaleX(${f})`;
        ember.style.transform = `translateX(${(1 - f) * 100}%)`;
        stick.parentElement!.dataset.low = String(f < 0.3 && f > 0);
      };
      const num = numRef.current!;
      const show = (text: string, sign: 'before' | 'after' | 'none') => {
        num.textContent = text;
        signBeforeRef.current!.hidden = sign !== 'before';
        signAfterRef.current!.hidden = sign !== 'after';
      };
      if (!r) {
        show('…', 'none');
        label.textContent = 'Connecting to the dojo';
        big.dataset.state = 'idle';
        burn(0);
        return;
      }
      if (r.phase === 'BETTING') {
        const left = Math.max(0, r.bettingEndsAt - clock.serverNow());
        show(`${(left / 1000).toFixed(1)}s`, 'none');
        label.textContent = 'Place your bets. The duel begins in';
        big.dataset.state = 'betting';
        burn(Math.min(1, left / 8000));
        if (lastTier !== -1) audio.setTier(-1);
        lastTier = -1;
      } else if (r.phase === 'RUNNING') {
        const { x100 } = liveMultiplier();
        show(formatX100(x100), 'after');
        const tier = x100 >= 500 ? 2 : x100 >= 200 ? 1 : 0;
        big.dataset.state = ['steady', 'enraged', 'frenzy'][tier];
        label.textContent = ['The ronin holds the line', 'The oni is enraged', 'Frenzy'][tier]!;
        burn(0);
        if (tier !== lastTier) audio.setTier(tier);
        lastTier = tier;
      } else {
        show(formatX100(r.crashX100 ?? 100), 'before');
        big.dataset.state = 'defeated';
        label.textContent = 'The oni lands the final blow';
        burn(0);
        lastTier = -3;
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [audio]);

  const crashed = (phase === 'CRASHED' || phase === 'SETTLED') && crashX100 != null;
  const [introDismissed, setIntroDismissed] = useState(false);
  const showIntro = !user && !introDismissed && phase !== undefined;
  const cashed = myBet?.status === 'CASHED_OUT' ? myBet : null;
  const lost = myBet?.status === 'LOST' ? myBet : null;
  const announce = crashed
    ? `Defeated at ${mult(crashX100)}.${cashed ? ` You cashed out at ${mult(cashed.cashoutX100!)}.` : lost ? ' Your stake was lost.' : ''}`
    : cashed
      ? `Cashed out at ${mult(cashed.cashoutX100!)}.`
      : '';

  return (
    <div className="scroll">
      {/* Brass caps on the scroll rods */}
      {['left-[-8px] top-[9px]', 'right-[-8px] top-[9px]', 'left-[-8px] bottom-[9px]', 'right-[-8px] bottom-[9px]'].map((pos) => (
        <span key={pos} aria-hidden className={`scroll-cap ${pos}`} />
      ))}
      <div className="scroll-surface aspect-[1.2/1] w-full sm:aspect-[16/9] sm:max-h-[max(340px,calc(100dvh-400px))]">
        <div ref={host} className="absolute inset-0" />

        <div className="pointer-events-none absolute inset-x-0 top-[4%] flex flex-col items-center text-center sm:top-[6%]" aria-live="off">
          <div ref={labelRef} className="text-sm tracking-wide text-washi/80 sm:text-base" />
          <div
            ref={bigRef}
            className="stage-multiplier tabular mt-1 font-display text-6xl leading-none font-extrabold sm:text-8xl lg:text-[7rem]"
            data-state="idle"
          >
            <span ref={signBeforeRef} className="x-sign" hidden>
              ×
            </span>
            <span ref={numRef} />
            <span ref={signAfterRef} className="x-sign" hidden>
              ×
            </span>
          </div>
          <div className="incense mt-3 sm:mt-4" aria-hidden>
            <div ref={incenseRef} className="incense-stick" />
            <div ref={emberRef} className="incense-ember" />
          </div>
        </div>

        {crashed ? (
          <div key={roundId} className="pointer-events-none absolute inset-x-0 top-[50%] grid -translate-y-1/2 place-items-center" aria-hidden>
            <span className="hanko text-4xl text-beni sm:text-5xl" data-rough="true" style={{ animationDelay: '380ms' }}>
              Defeated
            </span>
          </div>
        ) : null}

        {cashed || lost ? (
          <div key={`${myBet!.betId}-${myBet!.status}`} className="slip-in pointer-events-none absolute bottom-3 left-3 sm:bottom-5 sm:left-5" aria-hidden>
            {cashed ? (
              <div className="cut-sm bg-kin px-4 py-2 text-sumi">
                <div className="text-xs font-bold">Cashed out at {mult(cashed.cashoutX100!)}</div>
                <div className="tabular font-display text-2xl leading-tight font-extrabold">
                  {signedMoney(cashed.payout! - cashed.amount)} <span className="text-sm">{CURRENCY}</span>
                </div>
              </div>
            ) : (
              <div className="cut-sm bg-beni px-4 py-2 text-washi">
                <div className="text-xs font-bold">Stake lost</div>
                <div className="tabular font-display text-2xl leading-tight font-extrabold">
                  −{money(lost!.amount)} <span className="text-sm">{CURRENCY}</span>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {showIntro ? (
          <div className="slip-in absolute inset-x-2 bottom-2 sm:inset-x-4 sm:bottom-4">
            <div className="cut flex flex-wrap items-center gap-x-6 gap-y-2 bg-washi px-4 py-3 text-sumi">
              <h2 className="font-display text-2xl leading-none font-extrabold">Hold your nerve.</h2>
              <ol className="hidden flex-1 gap-x-5 text-[0.9rem] leading-snug md:flex">
                <li>
                  <b>1</b> Bet before the incense burns out
                </li>
                <li>
                  <b>2</b> The multiplier climbs while the ronin holds
                </li>
                <li>
                  <b>3</b> Cash out before the blow lands
                </li>
              </ol>
              <p className="flex-1 text-sm leading-snug md:hidden">Bet, hold, and cash out before the oni lands the blow.</p>
              <div className="flex items-center gap-2">
                {platformMode ? (
                  <p className="text-sm font-medium">Open Ronin Rush from your platform portal to play.</p>
                ) : (
                  <button type="button" onClick={requestAuth} className="cut-sm btn-flick bg-sumi px-4 py-2.5 font-display font-extrabold text-washi">
                    Enter the dojo
                  </button>
                )}
                <button type="button" onClick={() => setIntroDismissed(true)} className="px-2 py-2.5 text-sm underline underline-offset-4">
                  Just watch
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {announce}
      </p>
    </div>
  );
}
