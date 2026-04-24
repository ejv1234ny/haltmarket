// Real-data Playwright spec — walks the halt → market → bet → resolve →
// payout flow against a live Supabase + Postgres. Gated behind
// PLAYWRIGHT_USE_REAL_DB=1 so the default CI path (which uses mocks) stays
// fast + stable.
//
// Run locally:
//   export PLAYWRIGHT_USE_REAL_DB=1
//   export LEDGER_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres
//   export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
//   export NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
//   export SUPABASE_SERVICE_ROLE_KEY=eyJ...
//   supabase start                        # starts the local stack
//   pnpm --filter @haltmarket/web build   # or run dev in another shell
//   pnpm --filter @haltmarket/web start &
//   pnpm --filter @haltmarket/web test:e2e real-data-flow.spec.ts
//
// The test is intentionally idempotent on reruns — each run allocates a
// fresh symbol, email, and market id.

import { expect, test } from '@playwright/test';
import {
  dbEnabled,
  globalSum,
  lockMarket,
  pool,
  resolveMarket,
  seedOpenMarket,
} from './helpers/pg';
import {
  createAdminUser,
  generateMagicLink,
  loadAdminEnv,
} from './helpers/supabase-admin';

test.describe('real-data flow (PLAYWRIGHT_USE_REAL_DB=1)', () => {
  test.skip(!dbEnabled(), 'set PLAYWRIGHT_USE_REAL_DB=1 + REAL_DB_URL to run');

  test('sign in → place bet → resolve → history shows payout', async ({ page }) => {
    const env = loadAdminEnv();
    expect(env, 'SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL required').not.toBeNull();
    if (!env) return;

    const p = pool();
    const email = `e2e+${Date.now()}@example.test`;
    const password = `E2E!${Math.random().toString(36).slice(2, 10)}`;

    let userId: string;
    try {
      userId = await createAdminUser(env, email, password);
    } catch (e) {
      throw new Error(`admin createUser failed: ${(e as Error).message}`);
    }

    // Approve KYC + fund wallet directly; admin API doesn't do this for us.
    await p.query(
      `insert into public.user_profiles (user_id, kyc_status)
         values ($1, 'approved')
       on conflict (user_id) do update set kyc_status = excluded.kyc_status`,
      [userId],
    );
    await p.query(
      `select public.post_transfer(
         gen_random_uuid(), $1::jsonb, 'playwright:fund')`,
      [
        JSON.stringify([
          {
            user_id: userId,
            account: 'user_wallet',
            currency: 'USDC',
            amount_micro: '1000000000',
          },
          {
            user_id: userId,
            account: 'pending_deposits',
            currency: 'USDC',
            amount_micro: '-1000000000',
          },
        ]),
      ],
    );

    // Seed an open market with a freshly-generated halt.
    const market = await seedOpenMarket(p, 50);

    // Walk the browser through a magic-link sign-in. generate_link returns a
    // URL at the Supabase GoTrue endpoint that redirects to /auth/callback
    // on our site, which @supabase/ssr uses to set the session cookies.
    const verifyUrl = await generateMagicLink(env, email);
    await page.goto(verifyUrl);
    await page.waitForURL(new RegExp(`^${env.siteUrl.replace(/\/$/, '')}`));

    // Confirm we're signed in — nav shows the email.
    await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 });

    const sumBefore = await globalSum(p);

    await page.goto(`${env.siteUrl}/market/${market.marketId}`);
    await expect(page.getByRole('heading', { name: market.symbol })).toBeVisible();

    // Place a $25 bet at $52 (lands in a main bin above last_price).
    await page.getByTestId('price-input').fill('52.00');
    await page.getByTestId('stake-input').fill('25');
    await page.getByTestId('place-bet').click();
    await expect(page.getByTestId('bet-placed')).toBeVisible({ timeout: 10_000 });

    // Ledger still balanced after the bet.
    expect(await globalSum(p)).toBe(sumBefore);

    // Lock + resolve the market to land a payout in the user's history.
    await lockMarket(p, market.marketId);
    await resolveMarket(p, market.haltId, 52.1);
    expect(await globalSum(p)).toBe(sumBefore);

    await page.goto(`${env.siteUrl}/history`);
    await expect(page.getByText(market.symbol)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/paid/i).first()).toBeVisible({ timeout: 10_000 });

    await p.end();
  });
});
