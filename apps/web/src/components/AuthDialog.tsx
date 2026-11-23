'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type AuthResponse } from '@/lib/api';
import { useGame } from '@/lib/store';

export function AuthDialog({ open, onClose, onAuthed }: { open: boolean; onClose: () => void; onAuthed: (r: AuthResponse) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const platformMode = useGame((s) => s.platformMode);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  async function run(fn: () => Promise<AuthResponse>) {
    setBusy(true);
    setError(null);
    try {
      onAuthed(await fn());
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  // PLATFORM_MODE: identity belongs to platform-core; no guests, sign-up or passwords here.
  if (platformMode)
    return (
      <dialog
        ref={ref}
        onClose={onClose}
        aria-labelledby="auth-title"
        className="cut m-auto overscroll-contain w-[min(92vw,400px)] bg-washi p-0 text-sumi backdrop:bg-sumi/80"
      >
        <div className="border-t-[10px] border-beni p-6">
          <h2 id="auth-title" className="font-display text-2xl font-extrabold">
            Sign in on the platform
          </h2>
          <p className="mt-2 text-sm text-sumi/75">
            Accounts, balances and limits for this table are managed by the platform. Open Ronin Rush from your
            platform portal to play.
          </p>
          <button type="button" onClick={onClose} className="mt-5 w-full cut-sm bg-sumi py-3 font-display font-bold text-washi">
            Close
          </button>
        </div>
      </dialog>
    );

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="auth-title"
      className="cut m-auto overscroll-contain w-[min(92vw,400px)] bg-washi p-0 text-sumi backdrop:bg-sumi/80"
    >
      <div className="border-t-[10px] border-beni p-6">
        <h2 id="auth-title" className="font-display text-2xl font-extrabold">
          Enter the dojo
        </h2>
        <p className="mt-1 text-sm text-sumi/75">Play money only. You start with 1,000 ryō.</p>

        <button
          type="button"
          disabled={busy}
          onClick={() => void run(api.guest)}
          className="cut btn-flick mt-5 w-full bg-sumi py-3.5 font-display text-xl font-extrabold text-washi disabled:opacity-60"
        >
          Play as guest
        </button>

        <div className="mt-6 flex gap-4 border-b-2 border-sumi/20 text-sm" role="tablist">
          {(['signin', 'register'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              type="button"
              onClick={() => setMode(m)}
              className={`-mb-0.5 border-b-4 pb-2 ${mode === m ? 'border-beni font-bold text-sumi' : 'border-transparent text-sumi/65 hover:text-sumi'}`}
            >
              {m === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => (mode === 'signin' ? api.login(username, password) : api.register(username, password)));
          }}
        >
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-sumi/80">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              pattern="[A-Za-z0-9_]{3,20}"
              className="h-11 bg-white/55 px-3 text-base shadow-[inset_0_-3px_0_rgb(5_7_13/0.35)] outline-none focus:shadow-[inset_0_-3px_0_var(--color-beni)]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-sumi/80">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              className="h-11 bg-white/55 px-3 text-base shadow-[inset_0_-3px_0_rgb(5_7_13/0.35)] outline-none focus:shadow-[inset_0_-3px_0_var(--color-beni)]"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm font-medium text-beni">
              {error}
            </p>
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-sumi/75 hover:text-sumi">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="cut-sm bg-beni px-5 py-2.5 text-sm font-bold text-washi disabled:opacity-60">
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
