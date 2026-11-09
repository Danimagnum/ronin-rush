/** Token persistence. Storage can be unavailable (private mode, blocked cookies): never let that break the game. */
const KEY = 'ronin.session.v1';

export interface StoredSession {
  token: string;
  username: string;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`ronin.pref.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`ronin.pref.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
