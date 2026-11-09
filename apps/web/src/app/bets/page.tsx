'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useShell } from '@/components/AppShell';
import { Mult } from '@/components/Mult';
import { api, type MyBet } from '@/lib/api';
import { money, signedMoney } from '@/lib/format';
import { useGame } from '@/lib/store';

export default function MyBetsPage() {
  const token = useGame((s) => s.token);
  const lastSettled = useGame((s) => s.lastSettled?.roundId);
  const { requestAuth } = useShell();
  const [bets, setBets] = useState<MyBet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.myBets(token).then(setBets, () => setError('Could not load your bets. Refresh to try again.'));
  }, [token, lastSettled]);

  if (!token) {
    return (
      <div className="mx-auto max-w-prose py-10">
        <h1 className="font-display text-4xl font-extrabold">My bets</h1>
        <p className="mt-3 text-washi/85">Sign in or play as a guest to keep a history of your bets.</p>
        <button type="button" onClick={requestAuth} className="mt-6 rounded-xl bg-kin px-5 py-3 font-display text-lg font-extrabold text-ai-950">
          Enter the dojo
        </button>
      </div>
    );
  }

  const settled = bets?.filter((b) => b.status !== 'ACTIVE') ?? [];
  const net = settled.reduce((s, b) => s + (b.payout ?? 0) - b.amount, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-4xl font-extrabold">My bets</h1>
        {settled.length ? (
          <p className="text-sm text-mist">
            {settled.length} settled, net <span className={`tabular ${net >= 0 ? 'text-kin' : 'text-[#e07383]'}`}>{signedMoney(net)}</span>
          </p>
        ) : null}
      </div>
      {error ? <p className="mt-4 text-[#e8909c]">{error}</p> : null}
      {bets && bets.length === 0 ? (
        <p className="mt-8 text-washi/85">
          No bets yet.{' '}
          <Link href="/" className="text-kin underline-offset-4 hover:underline">
            Join the next duel
          </Link>
          .
        </p>
      ) : null}
      {bets && bets.length ? (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-mist">
              <tr className="border-b border-ai-700">
                <th className="py-2 pr-4 font-normal">Round</th>
                <th className="py-2 pr-4 text-right font-normal">Stake</th>
                <th className="py-2 pr-4 font-normal">Auto</th>
                <th className="py-2 pr-4 font-normal">Result</th>
                <th className="py-2 pr-4 text-right font-normal">Profit</th>
                <th className="py-2 font-normal">Crashed at</th>
              </tr>
            </thead>
            <tbody>
              {bets.map((b) => (
                <tr key={b.betId} className="border-b border-ai-700/60">
                  <td className="tabular py-2 pr-4">
                    <Link href={`/verify?round=${b.roundId}`} className="hover:text-kin">
                      #{b.roundId}
                    </Link>
                  </td>
                  <td className="tabular py-2 pr-4 text-right">{money(b.amount)}</td>
                  <td className="py-2 pr-4 text-mist">{b.autoX100 ? <Mult x100={b.autoX100} /> : '—'}</td>
                  <td className="py-2 pr-4">
                    {b.status === 'CASHED_OUT' ? (
                      <span className="text-kin">
                        Cashed out at <Mult x100={b.cashoutX100!} />
                        {b.autoCashout ? ' (auto)' : ''}
                      </span>
                    ) : b.status === 'LOST' ? (
                      <span className="text-[#e07383]">Busted</span>
                    ) : (
                      <span className="text-take">In play</span>
                    )}
                  </td>
                  <td className={`tabular py-2 pr-4 text-right ${b.status === 'CASHED_OUT' ? 'text-kin' : b.status === 'LOST' ? 'text-[#e07383]' : 'text-mist'}`}>
                    {b.status === 'ACTIVE' ? '—' : signedMoney((b.payout ?? 0) - b.amount)}
                  </td>
                  <td className="py-2 text-mist">{b.crashX100 ? <Mult x100={b.crashX100} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
