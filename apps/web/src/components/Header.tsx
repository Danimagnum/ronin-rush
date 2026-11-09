'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { SessionClock } from './SessionClock';
import { ApiError, api } from '@/lib/api';
import { CURRENCY } from '@/lib/config';
import { money } from '@/lib/format';
import { useGame } from '@/lib/store';

const NAV = [
  { href: '/', label: 'Play' },
  { href: '/verify', label: 'Verify' },
  { href: '/bets', label: 'My bets' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

/** Brand seal: an original hanko-style mark, the kanji 浪 ("wave", as in rōnin, the masterless "wave man"). */
function Seal() {
  return (
    <span aria-hidden className="grid h-8 w-8 place-items-center rounded-[6px] bg-beni font-display text-lg leading-none font-extrabold text-washi shadow-[inset_0_0_0_2px_rgba(232,226,210,0.25)]">
      浪
    </span>
  );
}

export function Header({ onSignIn, onSignOut }: { onSignIn: () => void; onSignOut: () => void }) {
  const pathname = usePathname();
  const user = useGame((s) => s.user);
  const token = useGame((s) => s.token);
  const connection = useGame((s) => s.connection);
  const latency = useGame((s) => s.latencyMs);
  const sound = useGame((s) => s.sound);
  const systemView = useGame((s) => s.systemView);
  const set = useGame((s) => s.set);
  const setBalance = useGame((s) => s.setBalance);
  const [refillMsg, setRefillMsg] = useState<string | null>(null);

  const low = user && user.balance < 10_000;

  return (
    <header className="border-b border-ai-700/70">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Seal />
          <span className="font-display text-xl font-extrabold tracking-tight">Ronin Rush</span>
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full gap-1 overflow-x-auto text-sm md:order-none md:w-auto">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={pathname === n.href ? 'page' : undefined}
              className={`rounded-md px-3 py-1.5 whitespace-nowrap ${pathname === n.href ? 'bg-ai-700 text-washi' : 'text-mist hover:text-washi'}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2 sm:gap-x-4">
          <span className="flex items-center gap-1.5 text-sm text-mist" title="Round-trip time to the game server">
            <span aria-hidden className={`h-2 w-2 rounded-full ${connection === 'online' ? (latency !== null && latency > 200 ? 'bg-kin' : 'bg-take') : connection === 'connecting' ? 'bg-mist' : 'bg-beni'}`} />
            <span className="tabular">{connection === 'online' ? (latency !== null ? `${latency} ms` : 'syncing') : connection}</span>
          </span>
          <SessionClock />
          <button
            type="button"
            aria-pressed={sound}
            onClick={() => set({ sound: !sound })}
            className="rounded-md px-2 py-1 text-sm text-mist hover:text-washi"
          >
            Sound {sound ? 'on' : 'off'}
          </button>
          <button
            type="button"
            aria-pressed={systemView}
            onClick={() => set({ systemView: !systemView })}
            className={`hidden rounded-md px-2 py-1 text-sm lg:block ${systemView ? 'bg-ai-700 text-washi' : 'text-mist hover:text-washi'}`}
          >
            System view
          </button>
          {user ? (
            <div className="flex items-center gap-3">
              <div className="text-right leading-tight">
                <div className="tabular font-display text-lg font-semibold text-kin">
                  {money(user.balance)} <span className="text-sm text-kin/70">{CURRENCY}</span>
                </div>
                <div className="text-xs text-mist">{user.username}</div>
              </div>
              {low && token ? (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const r = await api.refill(token);
                      setBalance(r.balance);
                      setRefillMsg(null);
                    } catch (e) {
                      setRefillMsg(e instanceof ApiError ? e.message : 'Refill failed');
                    }
                  }}
                  className="rounded-md border border-kin/40 px-2 py-1 text-xs text-kin hover:bg-kin/10"
                  title={refillMsg ?? 'Top up play money'}
                >
                  Refill
                </button>
              ) : null}
              <button type="button" onClick={onSignOut} className="text-xs text-mist hover:text-washi">
                Sign out
              </button>
            </div>
          ) : (
            <button type="button" onClick={onSignIn} className="rounded-lg bg-kin px-3 py-1.5 text-sm font-semibold text-ai-950 hover:bg-[#e2bf72]">
              Play
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
