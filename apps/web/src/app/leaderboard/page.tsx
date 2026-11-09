'use client';
import { useEffect, useState } from 'react';
import { Mult } from '@/components/Mult';
import { api, type LeaderboardEntry } from '@/lib/api';
import { money } from '@/lib/format';
import { useGame } from '@/lib/store';

type Boards = Awaited<ReturnType<typeof api.leaderboard>>;

export default function LeaderboardPage() {
  const [boards, setBoards] = useState<Boards | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settled = useGame((s) => s.lastSettled?.roundId);
  const me = useGame((s) => s.user?.id);

  useEffect(() => {
    api.leaderboard().then(setBoards, () => setError('Could not load the leaderboard. Refresh to try again.'));
  }, [settled]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-4xl font-extrabold">Today in the dojo</h1>
      <p className="mt-2 text-mist">Resets at midnight UTC{boards ? `, ${boards.date}` : ''}. Updates after every round.</p>
      {error ? <p className="mt-4 text-[#e8909c]">{error}</p> : null}
      <div className="mt-8 grid gap-10 md:grid-cols-2">
        <Board title="Best cash-out" entries={boards?.bestMultiplier ?? []} me={me} render={(v) => <Mult x100={v} className="text-kin" />} />
        <Board title="Biggest win" entries={boards?.biggestWin ?? []} me={me} render={(v) => <span className="tabular text-kin">+{money(v)}</span>} />
      </div>
    </div>
  );
}

function Board({ title, entries, me, render }: { title: string; entries: LeaderboardEntry[]; me?: string; render: (v: number) => React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      {entries.length === 0 ? <p className="mt-4 text-sm text-mist">No cash-outs yet today.</p> : null}
      <ol className="mt-4">
        {entries.map((e, i) => (
          <li key={e.userId} className={`grid grid-cols-[2rem_1fr_auto] items-baseline gap-3 border-b border-ai-700/60 py-2.5 ${e.userId === me ? 'bg-kin/5' : ''}`}>
            <span className={`tabular font-display text-lg ${i === 0 ? 'text-kin' : 'text-mist'}`}>{i + 1}</span>
            <span className="truncate">
              {e.username}
              {e.isBot ? <span className="ml-2 text-xs text-mist/70">bot</span> : null}
            </span>
            {render(e.value)}
          </li>
        ))}
      </ol>
    </section>
  );
}
