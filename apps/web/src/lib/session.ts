/** Token persistence. Storage can be unavailable (private mode, blocked cookies): never let that break the game. */
const KEY = 'ronin.session.v1';

export interface StoredSession {
  token: string;
  username: string;
}

/**
 * PLATFORM_MODE hand-off: a platform portal opens the game with `#platform_token=<Core JWT>`.
 * The token is taken from the fragment (never sent to servers in logs or Referer) and removed
 * from the address bar at once.
 */
export function takePlatformToken(): string | null {
  try {
    const m = /(?:^#|&)platform_token=([^&]+)/.exec(window.location.hash);
    if (!m) return null;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
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
