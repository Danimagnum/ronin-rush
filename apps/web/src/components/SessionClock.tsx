'use client';
import { useEffect, useState } from 'react';
import { ClockIcon } from './icons';
import { duration } from '@/lib/format';
import { savePref } from '@/lib/session';
import { useGame } from '@/lib/store';

/** Visible session timer: part of the responsible-gaming brief, always on screen. */
export function SessionClock({ compact = false }: { compact?: boolean }) {
  const startedAt = useGame((s) => s.sessionStartedAt);
  const [now, setNow] = useState<number | null>(null); // client-only: avoids an SSR/hydration mismatch
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="tabular flex items-center gap-1.5" title="Time playing this session">
      <ClockIcon className={compact ? 'text-xs' : 'text-base'} />
      <span className="sr-only">Session time </span>
      {now === null ? '0:00' : duration(now - startedAt)}
    </span>
  );
}

/** A gentle nudge every 30 minutes of play, with a real way to step away. */
export function BreakReminder() {
  const startedAt = useGame((s) => s.sessionStartedAt);
  const set = useGame((s) => s.set);
  const [dismissedAt, setDismissedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const minutes = Math.floor((now - startedAt) / 60_000);
  const due = minutes >= 30 && now - Math.max(dismissedAt, startedAt) >= 30 * 60_000;
  if (!due) return null;
  return (
    <div role="status" className="cut flex flex-wrap items-center justify-between gap-3 bg-plum/15 px-4 py-3 text-sm text-washi shadow-[inset_4px_0_0_var(--color-plum)]">
      <span>
        You have been playing for {minutes} minutes. A short break keeps the game fun.
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            const until = Date.now() + 5 * 60_000;
            set({ breakUntil: until });
            savePref('breakUntil', until);
            setDismissedAt(Date.now());
          }}
          className="cut-sm bg-plum px-3 py-2 font-bold text-sumi"
        >
          Take 5 minutes
        </button>
        <button type="button" onClick={() => setDismissedAt(Date.now())} className="px-3 py-2 text-plum hover:text-washi">
          Keep playing
        </button>
      </span>
    </div>
  );
}
