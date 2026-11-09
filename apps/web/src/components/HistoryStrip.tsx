'use client';
import Link from 'next/link';
import { Mult } from './Mult';
import { tierOf } from '@/lib/format';
import { useGame } from '@/lib/store';

const pill = {
  low: 'bg-ai-700 text-mist',
  mid: 'bg-take/15 text-take',
  high: 'bg-kin/15 text-kin',
  epic: 'bg-plum/15 text-plum',
};

/** Last rounds, newest first. Each links to its verification. */
export function HistoryStrip() {
  const history = useGame((s) => s.history);
  return (
    <nav aria-label="Recent rounds" className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
      {history.slice(0, 24).map((h) => (
        <Link
          key={h.roundId}
          href={`/verify?round=${h.roundId}&seed=${h.seed}`}
          title={`Round ${h.roundId}: verify`}
          className={`tabular shrink-0 rounded-[var(--radius-chip)] px-2.5 py-1 text-sm transition-opacity hover:opacity-80 ${pill[tierOf(h.crashX100)]}`}
        >
          <Mult x100={h.crashX100} />
        </Link>
      ))}
      {history.length === 0 ? <span className="text-sm text-mist">Rounds will appear here as they finish.</span> : null}
    </nav>
  );
}
