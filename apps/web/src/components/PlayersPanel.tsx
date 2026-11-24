'use client';
import type { PublicBet } from '@ronin/shared';
import { useMemo } from 'react';
import { Mult } from './Mult';
import { money, signedMoney } from '@/lib/format';
import { useGame } from '@/lib/store';

const edge = {
  ACTIVE: 'shadow-[inset_3px_0_0_var(--color-take)]',
  CASHED_OUT: 'shadow-[inset_3px_0_0_var(--color-kin-deep)]',
  LOST: 'shadow-[inset_3px_0_0_var(--color-beni)]',
} as Record<string, string>;

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
      <div className="flex items-baseline justify-between gap-3 border-b-4 border-hinoki px-1 pb-2">
        <h2 className="font-display text-xl font-extrabold">In the duel</h2>
        <span className="tabular text-sm text-washi/75">
          {list.length} {list.length === 1 ? 'player' : 'players'}
        </span>
      </div>
      <p className="tabular flex justify-between px-1 py-2 text-sm text-washi/75">
        <span>
          Staked <b className="font-medium text-washi">{money(staked)}</b>
        </span>
        <span>
          Won so far <b className="font-medium text-kin">{money(won)}</b>
        </span>
      </p>

      <ul className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.length === 0 ? (
          <li className="px-1 py-6 text-sm text-washi/70">{phase === 'BETTING' ? 'No bets yet. Be the first to face the oni.' : 'Nobody is in this round.'}</li>
        ) : null}
        {list.map((b) => {
          const mine = b.userId === me;
          return (
            <li
              key={b.betId}
              data-status={b.status}
              className={`roll-row grid grid-cols-[1fr_auto] items-center gap-x-3 border-b border-washi/10 py-2 pr-2 pl-3 text-sm ${mine ? 'bg-kin/10 shadow-[inset_4px_0_0_var(--color-kin)]' : edge[b.status]}`}
            >
              <span className="min-w-0">
                <span className={`block truncate font-medium ${mine ? 'text-kin' : b.status === 'LOST' ? 'text-washi/55' : 'text-washi'}`}>
                  {b.username}
                  {mine ? ' (you)' : ''}
                  {b.isBot ? <span className="ml-1.5 text-xs font-normal text-washi/50">bot</span> : null}
                </span>
                <span className="tabular text-xs text-washi/65">{money(b.amount)}</span>
              </span>
              <span className="tabular text-right">
                {b.status === 'CASHED_OUT' ? (
                  <>
                    <span className="block font-display text-base font-extrabold text-kin">{signedMoney(b.payout! - b.amount)}</span>
                    <span className="text-xs text-kin/80">
                      <Mult x100={b.cashoutX100!} />
                    </span>
                  </>
                ) : b.status === 'LOST' ? (
                  <span className="text-beni-soft">busted</span>
                ) : (
                  <span className="text-take">{b.autoX100 ? <>auto <Mult x100={b.autoX100} /></> : 'in play'}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
