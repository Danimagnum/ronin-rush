'use client';
import { formatX100, multiplierAt, multiplierX100At } from '@ronin/shared';
import { useEffect, useRef } from 'react';
import type { DuelAudio } from '@/game/audio';
import type { FightScene, SceneFrame } from '@/game/scene';
import { clock } from '@/lib/clock';
import { useGame } from '@/lib/store';

/** Live multiplier from the server's startedAt and our synced clock. Never sent anywhere. */
export function liveMultiplier(): { x: number; x100: number } {
  const r = useGame.getState().round;
  if (!r || r.phase !== 'RUNNING' || r.startedAt === null) return { x: 1, x100: 100 };
  const elapsed = clock.serverNow() - r.startedAt;
  return { x: multiplierAt(elapsed, r.k), x100: multiplierX100At(elapsed, r.k) };
}

export function GameStage({ audio }: { audio: DuelAudio }) {
  const host = useRef<HTMLDivElement>(null);
  const bigRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);
  const signBeforeRef = useRef<HTMLSpanElement>(null);
  const signAfterRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FightScene | null>(null);

  // Mount the Pixi scene once; it pulls state every frame, React never re-renders it.
  useEffect(() => {
    let disposed = false;
    const el = host.current!;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPower = window.matchMedia('(max-width: 640px)').matches || (navigator.hardwareConcurrency ?? 8) <= 4;
    // Pixel-art stage by default (one pixel grid for sprites and backdrop, ~9x fewer pixels to
    // fill); `?pixel=0` keeps the smooth high-resolution backdrop behind the sprites.
    const pixelArt = new URLSearchParams(window.location.search).get('pixel') !== '0';
    const frame = (): SceneFrame => {
      const r = useGame.getState().round;
      return { phase: r?.phase ?? 'IDLE', roundId: r?.roundId ?? 0, multiplier: liveMultiplier().x };
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
  }, [audio]);

  // Overlay text: updated imperatively at display rate.
  useEffect(() => {
    let raf = 0;
    let lastTier = -2;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const r = useGame.getState().round;
      const big = bigRef.current!;
      const label = labelRef.current!;
      const bar = barRef.current!;
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
        bar.style.transform = 'scaleX(0)';
        return;
      }
      if (r.phase === 'BETTING') {
        const left = Math.max(0, r.bettingEndsAt - clock.serverNow());
        show(`${(left / 1000).toFixed(1)}s`, 'none');
        label.textContent = 'Place your bets. The duel begins in';
        big.dataset.state = 'betting';
        bar.style.transform = `scaleX(${Math.min(1, left / 8000)})`;
        if (lastTier !== -1) audio.setTier(-1);
        lastTier = -1;
      } else if (r.phase === 'RUNNING') {
        const { x100 } = liveMultiplier();
        show(formatX100(x100), 'after');
        const tier = x100 >= 500 ? 2 : x100 >= 200 ? 1 : 0;
        big.dataset.state = ['steady', 'enraged', 'frenzy'][tier];
        label.textContent = ['The ronin holds the line', 'The oni is enraged', 'Frenzy'][tier]!;
        bar.style.transform = 'scaleX(0)';
        if (tier !== lastTier) audio.setTier(tier);
        lastTier = tier;
      } else {
        show(formatX100(r.crashX100 ?? 100), 'before');
        big.dataset.state = 'defeated';
        label.textContent = 'DEFEATED';
        bar.style.transform = 'scaleX(0)';
        lastTier = -3;
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [audio]);

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[var(--radius-panel)] bg-ai-950 sm:aspect-[16/9]">
      <div ref={host} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-x-0 top-[4%] flex flex-col items-center text-center sm:top-[6%]" aria-live="off">
        <div ref={labelRef} className="text-xs tracking-wide text-washi/70 sm:text-base" />
        <div
          ref={bigRef}
          className="stage-multiplier tabular mt-1 font-display text-5xl leading-none font-extrabold sm:text-8xl lg:text-[7rem]"
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
        <div className="mt-3 h-[3px] w-32 overflow-hidden rounded-full bg-washi/10 sm:mt-4 sm:w-40">
          <div ref={barRef} className="h-full origin-left bg-kin transition-transform duration-100 ease-linear" />
        </div>
      </div>
    </div>
  );
}
