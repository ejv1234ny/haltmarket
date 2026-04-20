import { test, expect } from '@playwright/test';

// Phase 7 cleanup: the same acceptance flow as the pre-cleanup PR but
// against the real data layer. When NEXT_PUBLIC_SUPABASE_URL is unset
// (default in CI), the data layer transparently falls back to the
// fixtures in `src/lib/data/fixtures.ts` — they seed the same markets,
// bets, and resolved AAPL row the specs assert on. Setting Supabase env
// vars swaps the queries without changing test IDs or copy.
//
// Seeded market IDs (must stay stable — asserted below):
//   mkt-nvda-1  — open, 72s to close, ~$118.42 last price
//   mkt-aapl-1  — resolved, reopen $191.05, closest-to-pin bonus awarded
//                 to the demo user for bet-1 (guess $191.25)

test.beforeAll(() => {
  // Fixture-mode seeds are populated on module import; no separate DB
  // seed step is needed here. When Supabase is wired in staging the CI
  // job points the env at a seeded branch DB with equivalent rows.
});

test('landing → market → place a bet → live pool update', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open halts' })).toBeVisible();

  // Sign-in page renders the magic-link form.
  await page.goto('/sign-in');
  await expect(page.getByTestId('email-input')).toBeVisible();
  await expect(page.getByRole('button', { name: /send magic link/i })).toBeVisible();

  // Open a live market.
  await page.goto('/');
  await page.getByRole('link', { name: /NVDA market/ }).click();
  await expect(page).toHaveURL(/\/market\//);

  // Ladder is behind a disclosure (ADR-0002 power-user affordance).
  await page.getByTestId('ladder-toggle').click();
  await expect(page.getByTestId('bin-ladder')).toBeVisible();

  // Grab the starting pool total — the realtime/fallback bin_delta event
  // will update it after we place a bet.
  const initialPool = await page.getByTestId('pool-total').textContent();

  // Place a bet via the guess-the-price UI.
  await page.getByTestId('price-input').fill('118.90');
  await page.getByTestId('stake-input').fill('25');
  await expect(page.getByTestId('bin-preview')).toContainText(/bin \$/);
  await expect(page.getByTestId('payout-estimate')).not.toHaveText('—');
  await expect(page.getByTestId('bonus-estimate')).not.toHaveText('—');
  await page.getByTestId('place-bet').click();
  await expect(page.getByTestId('bet-placed')).toBeVisible();

  // bin_delta event should have bumped the pool.
  await expect(page.getByTestId('pool-total')).not.toHaveText(initialPool ?? '');

  // History shows the settled AAPL bet (seeded via fixture).
  await page.goto('/history');
  await expect(page.getByText(/paid/i).first()).toBeVisible();

  // Wallet renders.
  await page.goto('/wallet');
  await expect(page.getByTestId('wallet-balance')).toBeVisible();

  // Leaderboard renders (fixture rows; real-data path requires service
  // role key which isn't set in the Playwright job).
  await page.goto('/leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
});

test('resolved market shows zone + bonus breakdown', async ({ page }) => {
  await page.goto('/market/mkt-aapl-1');
  await expect(page.getByTestId('resolution-breakdown')).toBeVisible();
  await page.getByTestId('breakdown-toggle').click();
  await expect(page.getByTestId('breakdown-bin')).toBeVisible();
  await expect(page.getByTestId('breakdown-bonus')).toBeVisible();
});

test('bet form blocks insufficient balance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /NVDA market/ }).click();
  await page.getByTestId('price-input').fill('118.90');
  await page.getByTestId('stake-input').fill('100000');
  await expect(page.getByTestId('place-bet')).toHaveText(/insufficient balance/i);
});

test('resolved market hides the bet form and shows the ladder on request', async ({ page }) => {
  await page.goto('/market/mkt-aapl-1');
  await expect(page.getByText(/betting closed/i)).toBeVisible();
  await page.getByTestId('ladder-toggle').click();
  await expect(page.getByTestId('bin-ladder')).toBeVisible();
});

// Phase 7 cleanup new spec: closest-to-pin bonus display.
//
// When a market resolves with a `closest_bonus_winner_user_id` set AND
// `closest_bonus_amount_micro > 0` (Phase 5's resolve_market populates
// both), the /market/[id] reopen summary must render both the winning
// bin's price range AND the bonus amount with a "closest prediction"
// attribution. Verified here against the seeded AAPL row, which has
// reopen $191.05, winning bin around $180–$195, and a ~$156 bonus
// (7% of the $2,260 fixture pool).
test('resolved market renders closest-to-pin bonus summary', async ({ page }) => {
  await page.goto('/market/mkt-aapl-1');
  const summary = page.getByTestId('reopen-summary');
  await expect(summary).toBeVisible();
  // The summary must include a "Bin: $X.XX–$Y.YY" price range...
  await expect(summary).toContainText(/Bin:\s*\$[\d,]+\.\d{2}/);
  // ...and the bonus tagline with "closest prediction" copy.
  const bonusLine = page.getByTestId('closest-bonus-summary');
  await expect(bonusLine).toBeVisible();
  await expect(bonusLine).toContainText(/Bonus:\s*\$[\d,]+\.\d{2}/);
  await expect(bonusLine).toContainText(/closest prediction/);
});
