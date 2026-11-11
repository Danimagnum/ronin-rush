'use client';
/**
 * Token hand-over from the platform portal that embeds the game (PLATFORM_MODE).
 *
 * Core access tokens live 10 minutes and the game never holds a refresh token (contracts 0.2.0,
 * docs/auth.md): the portal owns the session. Two messages, both window.postMessage:
 *
 *   game → portal   { type: 'ronin:token-request', expiresAt }   ~2 min before expiry, then every 20 s
 *   portal → game   { type: 'ronin:token', token }               a renewed Core access token
 *
 * Only messages from the exact origins in PORTAL_ORIGINS (GET /api/config) are accepted, and a
 * request is posted to each allowed origin explicitly, never to "*". The game then swaps the
 * socket's token with auth:renew; the server checks it belongs to the same player.
 */
export const TOKEN_REQUEST = 'ronin:token-request';
export const TOKEN_MESSAGE = 'ronin:token';
export const RENEW_BEFORE_MS = 120_000;
export const RETRY_EVERY_MS = 20_000;

export interface PortalHandover {
  stop: () => void;
  /** Re-plan the next request after the expiry changed (new token, reconnect). */
  schedule: (expiresAt: number | null) => void;
}

/** The parts of `window` the hand-over uses (injectable for tests). */
export interface HostWindow {
  parent: { postMessage: (message: unknown, targetOrigin: string) => void } | null;
  opener: { postMessage: (message: unknown, targetOrigin: string) => void } | null;
  addEventListener: (type: 'message', fn: (e: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', fn: (e: MessageEvent) => void) => void;
}

/** The embedding portal, if any: the parent frame, or the window that opened this tab. */
function portalWindow(win: HostWindow): HostWindow['parent'] {
  if (win.parent && win.parent !== (win as unknown)) return win.parent;
  return win.opener ?? null;
}

export function startPortalHandover(opts: {
  origins: string[];
  onToken: (token: string) => void;
  now?: () => number;
  win?: HostWindow;
}): PortalHandover {
  const now = opts.now ?? Date.now;
  const win = opts.win ?? (window as unknown as HostWindow);
  const allowed = new Set(opts.origins);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expiresAt: number | null = null;

  const onMessage = (e: MessageEvent) => {
    if (!allowed.has(e.origin)) return;
    const d = e.data as { type?: unknown; token?: unknown } | null;
    if (d && d.type === TOKEN_MESSAGE && typeof d.token === 'string' && d.token.length > 0) opts.onToken(d.token);
  };
  win.addEventListener('message', onMessage);

  const request = () => {
    const target = portalWindow(win);
    if (target) for (const origin of allowed) target.postMessage({ type: TOKEN_REQUEST, expiresAt }, origin);
    timer = setTimeout(request, RETRY_EVERY_MS); // keep asking until a token arrives (schedule() resets)
  };

  const schedule = (next: number | null) => {
    expiresAt = next;
    if (timer) clearTimeout(timer);
    timer = null;
    if (next === null || !allowed.size) return;
    timer = setTimeout(request, Math.max(0, next - RENEW_BEFORE_MS - now()));
  };

  return {
    schedule,
    stop: () => {
      if (timer) clearTimeout(timer);
      win.removeEventListener('message', onMessage);
    },
  };
}
