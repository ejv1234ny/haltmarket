# Playwright E2E tests

## Modes

### Mock mode (default, runs in CI)

`core-flow.spec.ts` walks the full UX flow (sign-in page → market card →
price input → bet placed → history) against the mocked data layer. No
Supabase credentials required. CI's `playwright smoke` job runs this on
every push.

```bash
pnpm --filter @haltmarket/web test:e2e
```

### Real-data mode (opt-in)

`real-data-flow.spec.ts` exercises the same flow end-to-end against a
**live Supabase** + **live Postgres**. Seeds a user via the admin API,
KYC-approves + funds them via pg, seeds a halt + market, signs in via a
generated magic-link verify URL, places a bet, resolves the market via
pg, and asserts the payout lands in `/history`. Ledger invariant
(`ledger_global_sum() = 0`) is checked at every step.

Skipped unless `PLAYWRIGHT_USE_REAL_DB=1`.

#### Local run against `supabase start`

```bash
# In one shell — local Supabase (GoTrue + Postgres + Realtime)
supabase start

# Capture the printed keys; the anon + service role + JWT secret are what
# matter here. The default DB URL is
# postgres://postgres:postgres@127.0.0.1:54322/postgres.

# In another shell — Next.js pointed at the local stack
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
export NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from `supabase start`>
export NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
export SUPABASE_SERVICE_ROLE_KEY=<service_role key from `supabase start`>
export LEDGER_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres
export PLAYWRIGHT_USE_REAL_DB=1

pnpm --filter @haltmarket/web build
pnpm --filter @haltmarket/web start &   # serves on :3000
pnpm --filter @haltmarket/web test:e2e real-data-flow.spec.ts
```

#### Run against a staging Supabase

Same vars as above, pointed at your staging project. The test allocates
fresh emails + symbols per run, so reruns don't collide. If you're
running against a shared staging DB, remember the seeded markets stay
there; periodically `delete from public.halts where symbol like 'E2E%';`
to keep things tidy.

## Helpers

- `helpers/pg.ts` — seed a funded+approved user, seed an open market, lock
  + resolve from test code, read `ledger_global_sum()`.
- `helpers/supabase-admin.ts` — admin-API calls (create user, generate
  magic link). Service-role credentials only.

## What real-data mode verifies that mock mode doesn't

| Property | Mock | Real-data |
|---|---|---|
| bet-form renders + client validation | ✅ | ✅ |
| `place-bet` edge function end-to-end | ❌ (only writes mock state) | ✅ |
| `place_bet` RPC — compliance gates + ledger | ❌ | ✅ |
| Supabase Realtime subscription wiring | ❌ (uses mock pub/sub) | ✅ |
| `resolve_market` + payouts | ❌ (baked into fixtures) | ✅ |
| RLS policies on user-scoped queries | ❌ (demo user) | ✅ |
| Ledger invariant preserved through UI flow | ❌ | ✅ |

Use real-data mode before tagging a release. Use mock mode as the
branch-protection required check.
