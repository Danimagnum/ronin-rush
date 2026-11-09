'use client';
import type { PublicBet } from '@ronin/shared';
import { useMemo } from 'react';
import { Mult } from './Mult';
import { money, signedMoney } from '@/lib/format';
import { useGame } from '@/lib/store';

const order = (b: PublicBet) => (b.status === 'CASHED_OUT' ? 0 : b.status === 'ACTIVE' ? 1 : 2);

/** Everyone in the current round: stake, then cash-out and profit, or busted. */
export function PlayersPanel() {
  const bets = useGame((s) => s.bets);
  const me = useGame((s) => s.user?.id);
  const phase = useGame((s) => s.round?.phase);

  const list = useMemo(
    () => Object.values(bets).sort((a, b) => order(a) - order(b) || (b.payout ?? b.amount) - (a.payout ?? a.amount)),
    [bets],
  );
  const staked = list.reduce((s, b) => s + b.amount, 0);
  const won = list.reduce((s, b) => s + (b.status === 'CASHED_OUT' ? b.payout! - b.amount : 0), 0);

  return (
    <section aria-label="Players in this round" className="flex min-h-0 flex-col">
      <div className="flex items-baseline justify-between px-1 pb-3">
        <h2 className="font-display text-lg font-semibold">In the duel</h2>
        <span className="tabular text-sm text-mist">
          {list.length} {list.length === 1 ? 'player' : 'players'}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-ai-700 text-sm">
        <div className="bg-ai-800 px-3 py-2">
          <dt className="text-mist">Staked</dt>
          <dd className="tabular mt-0.5 text-washi">{money(staked)}</dd>
        </div>
        <div className="bg-ai-800 px-3 py-2">
          <dt className="text-mist">Won so far</dt>
          <dd className="tabular mt-0.5 text-kin">{money(won)}</dd>
        </div>
      </dl>

      <div className="mt-3 grid grid-cols-[1fr_auto_auto] gap-x-3 px-1 pb-1.5 text-xs text-mist">
        <span>Player</span>
        <span className="text-right">Stake</span>
        <span className="w-24 text-right">Result</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.length === 0 ? (
          <li className="px-1 py-6 text-sm text-mist">{phase === 'BETTING' ? 'No bets yet. Be the first to face the oni.' : 'Nobody is in this round.'}</li>
        ) : null}
        {list.map((b) => (
          <li
            key={b.betId}
            className={`grid grid-cols-[1fr_auto_auto] items-center gap-x-3 border-b border-ai-700/60 px-1 py-2 text-sm ${b.userId === me ? 'bg-kin/5' : ''}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.status === 'ACTIVE' ? 'bg-take' : b.status === 'CASHED_OUT' ? 'bg-kin' : 'bg-beni'}`}
              />
              <span className={`truncate ${b.userId === me ? 'text-kin' : 'text-washi'}`}>
                {b.username}
                {b.userId === me ? ' (you)' : ''}
              </span>
              {b.isBot ? <span className="shrink-0 text-xs text-mist/70">bot</span> : null}
            </span>
            <span className="tabular text-right text-washi/85">{money(b.amount)}</span>
            <span className="tabular w-24 text-right">
              {b.status === 'CASHED_OUT' ? (
                <span className="text-kin">
                  <Mult x100={b.cashoutX100!} /> <span className="text-kin/80">{signedMoney(b.payout! - b.amount)}</span>
                </span>
              ) : b.status === 'LOST' ? (
                <span className="text-[#d46a7a]">busted</span>
              ) : (
                <span className="text-take">{b.autoX100 ? <>auto <Mult x100={b.autoX100} /></> : 'in play'}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
