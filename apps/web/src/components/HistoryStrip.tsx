'use client';
import Link from 'next/link';
import { Mult } from './Mult';
import { tierOf } from '@/lib/format';
import { useGame } from '@/lib/store';

const cut = {
  low: 'bg-mist/70',
  mid: 'bg-take',
  high: 'bg-kin',
  epic: 'bg-plum',
};
const label = {
  low: 'text-washi/65',
  mid: 'text-take',
  high: 'text-kin',
  epic: 'text-plum',
};

/** Height of a cut: log scale, so a 1.2x and a 40x are both readable on the same strip. */
const cutHeight = (x100: number) => Math.round(6 + 22 * Math.min(1, Math.log10(x100 / 100 + 1) / Math.log10(21)));

/** Last rounds as a tally of sword cuts, newest on the left. Each links to its verification. */
export function HistoryStrip() {
  const history = useGame((s) => s.history);
  return (
    <nav aria-label="Recent rounds" className="flex items-end gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
      {history.slice(0, 30).map((h) => {
        const t = tierOf(h.crashX100);
        return (
          <Link
            key={h.roundId}
            href={`/verify?round=${h.roundId}&seed=${h.seed}`}
            title={`Round ${h.roundId}: verify`}
            className="group flex w-[46px] shrink-0 flex-col items-center justify-end gap-1 py-1 hover:bg-ai-800"
          >
            <span className="tally flex h-[28px] items-end">
              <span className={`tally-cut ${cut[t]}`} style={{ height: cutHeight(h.crashX100) }} />
            </span>
            <span className={`tabular text-[0.8rem] leading-none font-medium ${label[t]}`}>
              <Mult x100={h.crashX100} />
            </span>
          </Link>
        );
      })}
      {history.length === 0 ? <span className="py-3 text-sm text-washi/65">Rounds will appear here as they finish.</span> : null}
    </nav>
  );
}
