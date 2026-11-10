import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';
import { apiUrl } from '../env';
import { balanceCents, playAsGuest, waitForFreshBetting, waitForState } from './helpers';

test('a cash-out that reaches the server after the crash is rejected', async ({ page }) => {
  await playAsGuest(page);
  await waitForFreshBetting(page);
  await page.getByRole('button', { name: /^Bet 10\.00/ }).click();
  await expect(page.getByRole('button', { name: /^Bet placed/ })).toBeVisible();
  const afterBet = await balanceCents(page);

  const roundId = Number((await page.locator('section[aria-label="Provably fair"]').innerText()).match(/Round #(\d+)/)![1]);
  await waitForState(page, (s) => s === 'defeated', 60_000);

  // The UI no longer offers a cash-out; a client that sends one anyway (a slow network, or a
  // tampered client) is judged on the server's receive time and refused.
  await expect(page.getByRole('button', { name: /^Cash out/ })).toHaveCount(0);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('ronin.session.v1')!).token as string);
  const socket = io(apiUrl, { transports: ['websocket'], auth: { token } });
  const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
    socket.emit('bet:cashout', { roundId, idempotencyKey: `late-${Date.now()}` }, resolve),
  );
  socket.disconnect();
  expect(ack).toEqual({ ok: false, error: 'CASHOUT_AFTER_CRASH' });

  // Nothing was paid: the stake stays lost.
  await expect(page.getByRole('button', { name: /^Defeated/ })).toBeVisible();
  expect(await balanceCents(page)).toBe(afterBet);
});
