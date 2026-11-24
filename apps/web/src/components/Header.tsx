'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { MenuIcon, SoundOffIcon, SoundOnIcon } from './icons';
import { SessionClock } from './SessionClock';
import { ApiError, api } from '@/lib/api';
import { CURRENCY } from '@/lib/config';
import { money } from '@/lib/format';
import { useGame } from '@/lib/store';

export const NAV = [
  { href: '/', label: 'Play' },
  { href: '/verify', label: 'Verify' },
  { href: '/bets', label: 'My bets' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

/** Brand seal: an original hanko-style mark, the kanji 浪 ("wave", as in rōnin, the masterless "wave man"). */
export function Seal({ size = 36 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.6 }}
      className="cut-sm grid shrink-0 place-items-center bg-beni font-display leading-none font-extrabold text-washi shadow-[inset_0_0_0_2px_rgba(235,228,208,0.28)]"
    >
      浪
    </span>
  );
}

/** Tops up play money when the purse runs low. Hidden in PLATFORM_MODE, where Core owns the wallet. */
export function RefillButton({ className = '' }: { className?: string }) {
  const user = useGame((s) => s.user);
  const token = useGame((s) => s.token);
  const platformMode = useGame((s) => s.platformMode);
  const setBalance = useGame((s) => s.setBalance);
  const [msg, setMsg] = useState<string | null>(null);
  if (!user || !token || platformMode || user.balance >= 10_000) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          const r = await api.refill(token);
          setBalance(r.balance);
          setMsg(null);
        } catch (e) {
          setMsg(e instanceof ApiError ? e.message : 'Refill failed');
        }
      }}
      title={msg ?? 'Top up play money'}
      className={`cut-sm bg-kin px-3 py-1.5 text-sm font-bold text-sumi ${className}`}
    >
      {msg ?? 'Refill purse'}
    </button>
  );
}

export function Latency({ className = '' }: { className?: string }) {
  const connection = useGame((s) => s.connection);
  const latency = useGame((s) => s.latencyMs);
  const tone = connection === 'online' ? (latency !== null && latency > 200 ? 'bg-kin' : 'bg-take') : connection === 'connecting' ? 'bg-mist' : 'bg-beni';
  return (
    <span className={`flex items-center gap-1.5 ${className}`} title="Round-trip time to the game server">
      <span aria-hidden className={`h-2 w-2 rounded-full ${tone}`} />
      <span className="tabular">{connection === 'online' ? (latency !== null ? `${latency} ms` : 'syncing') : connection}</span>
    </span>
  );
}

export function Header({ onSignIn, onMenu }: { onSignIn: () => void; onMenu: () => void }) {
  const pathname = usePathname();
  const user = useGame((s) => s.user);
  const sound = useGame((s) => s.sound);
  const systemView = useGame((s) => s.systemView);
  const set = useGame((s) => s.set);
  const platformMode = useGame((s) => s.platformMode);

  return (
    <header className="floor relative z-20 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-3 py-2 sm:gap-6 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Ronin Rush, home">
          <Seal />
          <span className="font-display text-xl font-extrabold tracking-tight whitespace-nowrap max-[420px]:hidden">Ronin Rush</span>
        </Link>

        <nav aria-label="Main" className="ml-2 hidden items-end gap-1 md:flex">
          {NAV.map((n) => {
            const active = pathname === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`relative px-3 py-2 text-[0.95rem] ${active ? 'font-bold text-washi' : 'text-washi/70 hover:text-washi'}`}
              >
                {n.label}
                {active ? <span aria-hidden className="absolute inset-x-2 -bottom-0.5 h-[3px] -skew-x-12 bg-kin" /> : null}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:gap-4">
          <div className="hidden items-center gap-4 text-sm text-washi/75 lg:flex">
            <Latency />
            <SessionClock />
          </div>
          {user ? (
            <div className="text-right leading-tight">
              <div className="tabular font-display text-lg font-semibold text-kin sm:text-xl">
                {money(user.balance)} <span className="text-xs text-kin/75 sm:text-sm">{CURRENCY}</span>
              </div>
              <div className="flex items-center justify-end gap-2 text-[0.7rem] text-washi/70 lg:hidden">
                <SessionClock compact />
                <Latency />
              </div>
              <div className="hidden text-xs text-washi/70 lg:block">{user.username}</div>
            </div>
          ) : platformMode ? (
            <span className="hidden text-xs text-washi/70 sm:block">Open Ronin Rush from your platform portal</span>
          ) : (
            <button type="button" onClick={onSignIn} className="cut-sm bg-kin px-4 py-2 text-sm font-bold text-sumi">
              Enter the dojo
            </button>
          )}
          <RefillButton className="hidden md:block" />
          <button
            type="button"
            aria-pressed={sound}
            aria-label={sound ? 'Sound on. Turn it off' : 'Sound off. Turn it on'}
            onClick={() => set({ sound: !sound })}
            className={`grid h-11 w-11 place-items-center text-2xl ${sound ? 'text-kin' : 'text-washi/65 hover:text-washi'}`}
          >
            {sound ? <SoundOnIcon /> : <SoundOffIcon />}
          </button>
          <button
            type="button"
            aria-pressed={systemView}
            onClick={() => set({ systemView: !systemView })}
            className={`hidden h-11 items-center px-3 text-sm lg:flex ${systemView ? 'bg-ai-700 font-bold text-washi' : 'text-washi/70 hover:text-washi'}`}
          >
            System view
          </button>
          <button type="button" onClick={onMenu} aria-label="Menu and settings" className="grid h-11 w-11 place-items-center text-2xl text-washi hover:text-kin">
            <MenuIcon />
          </button>
        </div>
      </div>
    </header>
  );
}

