'use client';
import { useEffect, useState } from 'react';
import { duration } from '@/lib/format';
import { useGame } from '@/lib/store';

/** Visible session timer: part of the responsible-gaming brief, always on screen. */
export function SessionClock() {
  const startedAt = useGame((s) => s.sessionStartedAt);
  const [now, setNow] = useState<number | null>(null); // client-only: avoids an SSR/hydration mismatch
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="tabular text-sm text-mist" title="Time playing this session">
      Session {now === null ? '0:00' : duration(now - startedAt)}
    </span>
  );
}

/** A gentle nudge every 30 minutes of play. */
export function BreakReminder() {
  const startedAt = useGame((s) => s.sessionStartedAt);
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
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-plum/10 px-4 py-3 text-sm text-washi ring-1 ring-plum/30">
      <span>You have been playing for {minutes} minutes. A short break keeps the game fun.</span>
      <button type="button" onClick={() => setDismissedAt(Date.now())} className="rounded px-2 py-1 text-plum hover:bg-plum/10">
        Keep playing
      </button>
    </div>
  );
}
