'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type AuthResponse } from '@/lib/api';

export function AuthDialog({ open, onClose, onAuthed }: { open: boolean; onClose: () => void; onAuthed: (r: AuthResponse) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="auth-title"
      className="m-auto w-[min(92vw,400px)] rounded-[var(--radius-panel)] bg-ai-800 p-0 text-washi backdrop:bg-ai-950/80"
    >
      <div className="p-6">
        <h2 id="auth-title" className="font-display text-2xl font-extrabold">
          Enter the dojo
        </h2>
        <p className="mt-1 text-sm text-mist">Play money only. You start with 1,000 ryō.</p>

        <button
          type="button"
          disabled={busy}
          onClick={() => void run(api.guest)}
          className="mt-5 w-full rounded-xl bg-kin py-3 font-display text-lg font-extrabold text-ai-950 hover:bg-[#e2bf72] disabled:opacity-60"
        >
          Play as guest
        </button>

        <div className="mt-6 flex gap-4 border-b border-ai-700 text-sm" role="tablist">
          {(['signin', 'register'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              type="button"
              onClick={() => setMode(m)}
              className={`-mb-px border-b-2 pb-2 ${mode === m ? 'border-kin text-washi' : 'border-transparent text-mist hover:text-washi'}`}
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
            <span className="text-mist">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              pattern="[A-Za-z0-9_]{3,20}"
              className="rounded-lg bg-ai-950 px-3 py-2 ring-1 ring-ai-600 outline-none focus:ring-kin"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-mist">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              className="rounded-lg bg-ai-950 px-3 py-2 ring-1 ring-ai-600 outline-none focus:ring-kin"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-[#e8909c]">
              {error}
            </p>
          ) : null}
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-mist hover:text-washi">
              Cancel
            </button>
            <button type="submit" disabled={busy} className="rounded-lg bg-ai-600 px-4 py-2 text-sm font-medium hover:bg-ai-700 disabled:opacity-60">
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
