'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthDialog } from './AuthDialog';
import { Header } from './Header';
import { ResponsibleGaming } from './ResponsibleGaming';
import { DuelAudio } from '@/game/audio';
import { api, type AuthResponse } from '@/lib/api';
import { connect, disconnect } from '@/lib/realtime';
import { loadPref, loadSession, savePref, saveSession } from '@/lib/session';
import { useGame } from '@/lib/store';
import { createContext, useContext } from 'react';

interface Shell {
  audio: DuelAudio;
  requestAuth: () => void;
}
const ShellContext = createContext<Shell | null>(null);
export const useShell = () => useContext(ShellContext)!;

/** Restores the session, owns the socket for the whole app, and hosts the auth dialog. */
export function AppShell({ children }: { children: ReactNode }) {
  const [authOpen, setAuthOpen] = useState(false);
  const audio = useMemo(() => (typeof window === 'undefined' ? (null as unknown as DuelAudio) : new DuelAudio()), []);
  const setAuth = useGame((s) => s.setAuth);
  const sound = useGame((s) => s.sound);
  const set = useGame((s) => s.set);

  useEffect(() => {
    set({ sound: loadPref('sound', false), sessionStartedAt: loadPref('sessionStartedAt', Date.now()) });
    const s = loadSession();
    if (!s) {
      connect(null);
      return () => disconnect();
    }
    api
      .me(s.token)
      .then((user) => {
        setAuth(s.token, user);
        connect(s.token);
      })
      .catch(() => {
        saveSession(null);
        connect(null);
      });
    return () => disconnect();
  }, [set, setAuth]);

  // Session timer survives reloads within the same tab session window.
  useEffect(() => {
    const start = useGame.getState().sessionStartedAt;
    savePref('sessionStartedAt', start);
    const reset = () => savePref('sessionStartedAt', Date.now());
    window.addEventListener('pagehide', () => {
      if (Date.now() - start > 4 * 3600_000) reset();
    });
  }, []);

  useEffect(() => {
    savePref('sound', sound);
    audio?.setEnabled(sound);
  }, [audio, sound]);

  const onAuthed = (r: AuthResponse) => {
    saveSession({ token: r.token, username: r.user.username });
    setAuth(r.token, r.user);
    connect(r.token);
  };

  return (
    <ShellContext.Provider value={{ audio, requestAuth: () => setAuthOpen(true) }}>
      <div className="flex min-h-dvh flex-col">
        <Header
          onSignIn={() => setAuthOpen(true)}
          onSignOut={() => {
            saveSession(null);
            setAuth(null, null);
            connect(null);
          }}
        />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-4 sm:px-6 sm:py-6">{children}</main>
        <ResponsibleGaming />
      </div>
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} onAuthed={onAuthed} />
    </ShellContext.Provider>
  );
}
