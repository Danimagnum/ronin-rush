import { expect, test } from '@playwright/test';

test('the verify page recomputes a finished round in the browser', async ({ page }) => {
  await page.goto('/');
  const pill = page.locator('nav[aria-label="Recent rounds"] a').first();
  await expect(pill).toBeVisible({ timeout: 45_000 });
  const shown = (await pill.innerText()).replace(/[^0-9.]/g, '');
  await pill.click();
  await expect(page).toHaveURL(/\/verify\?round=\d+&seed=[0-9a-f]{64}/);
  await expect(page.getByText(/reaches the commitment after \d+ hashes/)).toBeVisible();
  await expect(page.locator('section[aria-label="Verifier"]').getByText(`${shown}×`, { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Mismatch')).toHaveCount(0);
});
