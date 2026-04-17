import { test, expect } from '@playwright/test';

// This smoke test exercises the AGENTS.md §Phase 7 acceptance flow against
// the mocked data layer: sign up (demo) → see markets → place a bet → see a
// resolved market with a payout. The real Supabase/edge-function wiring
// lands in a follow-up PR once Phases 3-5 merge.

test('sees markets, places a bet, sees a resolved payout', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open halts' })).toBeVisible();

  // Sign-in page is reachable (magic-link + Google options render).
  await page.goto('/sign-in');
  await expect(page.getByTestId('email-input')).toBeVisible();
  await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();

  // Open a live market.
  await page.goto('/');
  await page.getByRole('link', { name: /NVDA market/ }).click();
  await expect(page).toHaveURL(/\/market\//);
  await expect(page.getByTestId('bin-ladder')).toBeVisible();

  // Place a bet via the guess-the-price UI.
  await page.getByTestId('price-input').fill('118.90');
  await page.getByTestId('stake-input').fill('25');
  await expect(page.getByTestId('resolved-bin')).not.toHaveText('—');
  await expect(page.getByTestId('payout-estimate')).not.toHaveText('—');
  await page.getByTestId('place-bet').click();
  await expect(page.getByTestId('bet-placed')).toBeVisible();

  // The pool total reflects the realtime broadcast.
  await expect(page.getByTestId('pool-total')).toBeVisible();

  // History page shows a settled bet with a payout (the resolved mock).
  await page.goto('/history');
  await expect(page.getByText(/paid/i).first()).toBeVisible();

  // Wallet shows a balance.
  await page.goto('/wallet');
  await expect(page.getByTestId('wallet-balance')).toBeVisible();

  // Leaderboard renders.
  await page.goto('/leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
});

test('bet form blocks insufficient balance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /NVDA market/ }).click();
  await page.getByTestId('price-input').fill('118.90');
  await page.getByTestId('stake-input').fill('100000');
  await expect(page.getByTestId('place-bet')).toHaveText(/insufficient balance/i);
});

test('resolved market hides the bet form', async ({ page }) => {
  await page.goto('/market/mkt-aapl-1');
  await expect(page.getByText(/betting closed/i)).toBeVisible();
  await expect(page.getByTestId('bin-ladder')).toBeVisible();
});
