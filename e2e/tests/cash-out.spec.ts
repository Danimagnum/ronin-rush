import { expect, test } from '@playwright/test';
import { balanceCents, playAsGuest, running, stageState, toCents, waitForFreshBetting, waitForState } from './helpers';

test('bet, cash out during the duel and see the payout', async ({ page }) => {
  await playAsGuest(page);
  await expect.poll(() => balanceCents(page)).toBe(100_000);

  // A round can crash at 1.00x (≈2% of rounds) before anyone can cash out; try a few rounds.
  for (let attempt = 1; attempt <= 6; attempt++) {
    await waitForFreshBetting(page);
    const before = await balanceCents(page);
    await page.getByRole('button', { name: /^Bet 10\.00/ }).click();
    await expect(page.getByRole('button', { name: /^Bet placed/ })).toBeVisible();
    await expect.poll(() => balanceCents(page)).toBe(before - 1_000);

    const state = await waitForState(page, (s) => running(s) || s === 'defeated');
    if (state === 'defeated') continue;

    const cashOut = page.getByRole('button', { name: /^Cash out/ });
    await cashOut.click({ timeout: 2_000 }).catch(() => undefined);
    const cashed = page.getByRole('button', { name: /^Cashed out at/ });
    const outcome = await Promise.race([
      cashed.waitFor({ timeout: 10_000 }).then(() => 'cashed' as const),
      page.getByRole('button', { name: /^Defeated/ }).waitFor({ timeout: 10_000 }).then(() => 'lost' as const),
    ]);
    if (outcome === 'lost') continue;

    // The server decided the multiplier; the UI shows it and pays stake × multiplier, floored.
    const label = await cashed.innerText();
    const x100 = toCents(label.match(/at ([\d.]+)/)![1]!);
    expect(x100).toBeGreaterThanOrEqual(100);
    const payout = Math.floor((1_000 * x100) / 100);
    await expect.poll(() => balanceCents(page)).toBe(before - 1_000 + payout);
    await expect(page.locator('section[aria-label="Players in this round"]').getByText(/\(you\)/)).toBeVisible();
    return;
  }
  throw new Error(`no round lasted long enough to cash out in 6 attempts (last state ${await stageState(page)})`);
});
