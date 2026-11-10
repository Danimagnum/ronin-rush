import { expect, type Page } from '@playwright/test';

export type StageState = 'idle' | 'betting' | 'steady' | 'enraged' | 'frenzy' | 'defeated';

export const stageState = (page: Page) =>
  page.locator('.stage-multiplier').getAttribute('data-state') as Promise<StageState | null>;

export async function waitForState(page: Page, accept: (s: StageState | null) => boolean, timeout = 45_000): Promise<StageState> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await stageState(page);
    if (accept(s)) return s!;
    await page.waitForTimeout(40);
  }
  throw new Error(`stage never reached the expected state (last: ${await stageState(page)})`);
}

/** Waits for a betting window with enough time left to place a bet comfortably. */
export async function waitForFreshBetting(page: Page): Promise<void> {
  const current = await stageState(page);
  if (current === 'betting') await waitForState(page, (s) => s !== 'betting');
  await waitForState(page, (s) => s === 'betting');
}

export const running = (s: StageState | null) => s === 'steady' || s === 'enraged' || s === 'frenzy';

/** "1,234.56" -> 123456 cents */
export const toCents = (text: string) => Math.round(parseFloat(text.replace(/[^0-9.]/g, '')) * 100);

export async function balanceCents(page: Page): Promise<number> {
  const text = await page.locator('header .font-display.text-kin').first().innerText();
  return toCents(text);
}

export async function playAsGuest(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Play as guest' }).click();
  const name = page.locator('header').getByText(/^guest_[0-9a-f]{6}$/);
  await expect(name).toBeVisible();
  return name.innerText();
}
