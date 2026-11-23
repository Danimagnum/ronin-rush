'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { NAV, RefillButton, Seal } from './Header';
import { CloseIcon } from './icons';
import { SessionClock } from './SessionClock';
import { CURRENCY } from '@/lib/config';
import { money } from '@/lib/format';
import { savePref } from '@/lib/session';
import { useGame } from '@/lib/store';

const BREAKS = [5, 15, 30];

/** One labelled on/off or either/or setting, with a real switch semantic for assistive tech. */
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-washi/10 py-3">
      <div className="min-w-0">
        <div className="text-[0.95rem] font-medium">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-snug text-washi/65">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-8 w-14 shrink-0 ${on ? 'bg-kin' : 'bg-ai-600'}`}
    >
      <span className={`absolute top-1 left-0 h-6 w-6 transition-transform ${on ? 'translate-x-7 bg-sumi' : 'translate-x-1 bg-washi'}`} />
    </button>
  );
}

/** Menu, settings and rest, in one sheet: a bottom sheet under the thumb on phones, a side panel on desktop. */
export function MenuSheet({ open, onClose, onSignOut, onSignIn }: { open: boolean; onClose: () => void; onSignOut: () => void; onSignIn: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const user = useGame((s) => s.user);
  const sound = useGame((s) => s.sound);
  const effects = useGame((s) => s.effects);
  const systemView = useGame((s) => s.systemView);
  const breakUntil = useGame((s) => s.breakUntil);
  const platformMode = useGame((s) => s.platformMode);
  const set = useGame((s) => s.set);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  // Navigating closes the sheet.
  useEffect(() => onClose(), [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const resting = breakUntil > Date.now();

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="menu-title"
      className="fixed inset-x-0 bottom-0 m-0 overscroll-contain max-h-[88dvh] w-full max-w-none overflow-y-auto bg-ai-900 p-0 text-washi shadow-[0_-8px_0_var(--color-hinoki)] backdrop:bg-sumi/75 sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[380px] sm:shadow-[-8px_0_0_var(--color-hinoki)]"
    >
      <div className="safe-bottom px-5 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Seal size={32} />
            <h2 id="menu-title" className="font-display text-xl font-extrabold">
              Dojo menu
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close menu" className="grid h-11 w-11 place-items-center text-2xl text-washi/80 hover:text-washi">
            <CloseIcon />
          </button>
        </div>

        <nav aria-label="Pages" className="mt-3 grid grid-cols-2 gap-2 md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={pathname === n.href ? 'page' : undefined}
              className={`cut-sm px-4 py-3.5 text-center font-medium ${pathname === n.href ? 'bg-kin font-bold text-sumi' : 'bg-ai-700 text-washi'}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <section aria-label="Settings" className="mt-4">
          <h3 className="font-display text-base font-semibold text-washi/75">Settings</h3>
          <Row label="Sound" hint="Steel, taiko and a gong. Off until you turn it on.">
            <Switch on={sound} onChange={(v) => set({ sound: v })} label="Sound" />
          </Row>
          <Row label="Reduced effects" hint="Fewer particles and a simpler backdrop. Helps older phones and laptops.">
            <Switch
              on={effects === 'low'}
              onChange={(v) => {
                set({ effects: v ? 'low' : 'auto' });
                savePref('effects', v ? 'low' : 'auto');
              }}
              label="Reduced effects"
            />
          </Row>
          <Row label="System view" hint="Live server clock, events and ledger. Needs a wide screen.">
            <span className="hidden lg:block">
              <Switch on={systemView} onChange={(v) => set({ systemView: v })} label="System view" />
            </span>
            <span className="text-xs text-washi/55 lg:hidden">Desktop only</span>
          </Row>
        </section>

        <section aria-label="Take a break" className="mt-4">
          <h3 className="font-display text-base font-semibold text-washi/75">Rest</h3>
          <p className="mt-1 text-sm leading-snug text-washi/75">
            Pauses new bets on this device. Rounds keep running for everyone, and a bet you already placed still pays out or loses as usual.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {BREAKS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={resting}
                onClick={() => {
                  const until = Date.now() + m * 60_000;
                  set({ breakUntil: until });
                  savePref('breakUntil', until);
                  onClose();
                }}
                className="cut-sm bg-ai-700 px-4 py-2.5 text-sm font-medium hover:bg-ai-600 disabled:opacity-45"
              >
                {m} minutes
              </button>
            ))}
          </div>
          {resting ? <p className="mt-2 text-sm text-plum">You are on a break. New bets are paused here.</p> : null}
        </section>

        <section aria-label="Account" className="mt-5 border-t border-washi/10 pt-4">
          {user ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{user.username}</div>
                <div className="tabular font-display text-lg text-kin">
                  {money(user.balance)} <span className="text-sm text-kin/75">{CURRENCY}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <RefillButton />
                {!platformMode ? (
                  <button type="button" onClick={onSignOut} className="px-2 py-2 text-sm text-washi/75 hover:text-washi">
                    Sign out
                  </button>
                ) : null}
              </div>
            </div>
          ) : platformMode ? (
            <p className="text-sm text-washi/75">Open Ronin Rush from your platform portal to play.</p>
          ) : (
            <button type="button" onClick={onSignIn} className="cut w-full bg-kin py-3 font-display text-lg font-extrabold text-sumi">
              Enter the dojo
            </button>
          )}
          <div className="mt-3 flex items-center justify-between text-sm text-washi/70">
            <span>This session</span>
            <SessionClock />
          </div>
        </section>
      </div>
    </dialog>
  );
}
