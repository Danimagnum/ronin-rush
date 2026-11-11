import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RENEW_BEFORE_MS, RETRY_EVERY_MS, TOKEN_MESSAGE, TOKEN_REQUEST, startPortalHandover, type HostWindow } from './portal';

const PORTAL = 'https://portal.example';

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const posted: Array<{ message: unknown; origin: string }> = [];
  const win: HostWindow = {
    parent: { postMessage: (message, origin) => posted.push({ message, origin }) },
    opener: null,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  };
  const deliver = (origin: string, data: unknown) => listeners.forEach((fn) => fn({ origin, data } as MessageEvent));
  return { win, posted, deliver, listeners };
}

describe('portal token hand-over', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the portal 2 minutes before expiry, only at the allowed origin, and keeps asking', () => {
    const { win, posted } = fakeWindow();
    const now = Date.now();
    const h = startPortalHandover({ origins: [PORTAL], onToken: () => {}, win, now: () => now });
    h.schedule(now + 10 * 60_000);
    vi.advanceTimersByTime(10 * 60_000 - RENEW_BEFORE_MS - 1);
    expect(posted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(posted).toEqual([{ message: { type: TOKEN_REQUEST, expiresAt: now + 10 * 60_000 }, origin: PORTAL }]);
    vi.advanceTimersByTime(RETRY_EVERY_MS);
    expect(posted).toHaveLength(2); // no answer yet: ask again
    h.stop();
  });

  it('accepts tokens only from allowed origins and in the expected shape', () => {
    const { win, deliver, listeners } = fakeWindow();
    const onToken = vi.fn();
    const h = startPortalHandover({ origins: [PORTAL], onToken, win });
    deliver('https://evil.example', { type: TOKEN_MESSAGE, token: 'stolen' });
    deliver(PORTAL, { type: 'something-else', token: 'x' });
    deliver(PORTAL, { type: TOKEN_MESSAGE, token: '' });
    deliver(PORTAL, { type: TOKEN_MESSAGE, token: 42 });
    expect(onToken).not.toHaveBeenCalled();
    deliver(PORTAL, { type: TOKEN_MESSAGE, token: 'core.jwt.token' });
    expect(onToken).toHaveBeenCalledExactlyOnceWith('core.jwt.token');
    h.stop();
    expect(listeners.size).toBe(0);
  });

  it('a new expiry re-plans the request; no portal origins means no requests at all', () => {
    const { win, posted } = fakeWindow();
    const now = Date.now();
    const h = startPortalHandover({ origins: [PORTAL], onToken: () => {}, win, now: () => now });
    h.schedule(now + 5 * 60_000);
    h.schedule(now + 10 * 60_000); // renewed before the first request fired
    vi.advanceTimersByTime(5 * 60_000);
    expect(posted).toHaveLength(0);
    h.stop();
    const none = fakeWindow();
    const h2 = startPortalHandover({ origins: [], onToken: () => {}, win: none.win, now: () => now });
    h2.schedule(now);
    vi.advanceTimersByTime(60_000);
    expect(none.posted).toHaveLength(0);
    h2.stop();
  });
});
