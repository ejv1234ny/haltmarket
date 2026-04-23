# Alpha Launch — Human Setup Checklist

All code-level alpha blockers are resolved (see `docs/progress.md`).
What's left is infra, credentials, legal, and ops configuration that only a human can do. Work through this checklist top to bottom — items earlier in the list block items later.

## 1. Supabase project

- [x ] Verify project `sqjdfafewyphoroaivqq` is the prod project (or create a new one).
- [ x] Create a **Personal Access Token** at https://supabase.com/dashboard/account/tokens → save as `SUPABASE_ACCESS_TOKEN`.
- [ x] Copy the **database password** from Project Settings → Database → save as `SUPABASE_DB_PASSWORD`.
- [x ] Enable Realtime broadcast on the project (Database → Replication → ensure `supabase_realtime` publication exists; broadcasts work out of the box but verify).
- [ x] In Auth → URL Configuration, set:
  - Site URL: `https://haltmarket.com`
  - Redirect URLs: `https://haltmarket.com/auth/callback`, `http://localhost:3000/auth/callback`
- [x ] Enable **Google OAuth** in Auth → Providers (needs Google Cloud OAuth client — Web app type).
- [ x] Seed `public.compliance_settings`: already handled by migration `0007` defaults (`require_kyc=true`, `aggregate_cap_micro=15_000_000_000`). If you want to launch the alpha with KYC **disabled for an internal beta**, run:
  ```sql
  update public.compliance_settings set require_kyc = false where id = 1;
  ```
  Remember to re-enable before onboarding external users.
- [ ] Optionally populate `public.blocked_regions` with ISO country codes you need to block (e.g. `insert into blocked_regions values ('CN','policy')`).

## 2. Vercel (web frontend)

- [ x] Create a Vercel project linked to this GitHub repo.
- [ x] In project settings → **General**, set Root Directory to `apps/web`.
- [x ] Install command / build command are auto-picked from `apps/web/vercel.json`; verify Next.js framework preset.
- [x ] In project settings → **Environment Variables** (Production):
  - `NEXT_PUBLIC_SUPABASE_URL` = `https://sqjdfafewyphoroaivqq.supabase.co`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = (Supabase project → API → `anon` key)
  - `NEXT_PUBLIC_SITE_URL` = `https://haltmarket.com`
- [x ] Point `haltmarket.com` → Vercel deployment (DNS A/AAAA to `76.76.21.21` or CNAME per Vercel docs).
- [ ] From the Vercel project's **Tokens** section (or account-level), create a deploy token → save as `VERCEL_TOKEN` in GitHub repo secrets. Also add `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` from Vercel project settings.

## 3. Railway (monitor + resolver workers)

- [ ] Create a Railway project.
- [ ] Create two services:
  - `haltmarket-monitor` — Root Directory `apps/monitor`, Dockerfile auto-detected
  - `haltmarket-resolver` — Root Directory `apps/resolver`, Dockerfile auto-detected
- [ ] Each service needs these env vars (set in Railway UI):
  - `DATABASE_URL` (Supabase → Settings → Database → Connection string → URI; use the **session pooler** port 5432 with SSL)
  - `POLYGON_API_KEY` (Polygon.io paid tier — `/v3/trades/{symbol}` requires at least Launchpad)
  - `DISCORD_WEBHOOK_URL` (Discord channel → Edit Channel → Integrations → Webhooks)
  - Monitor only: `MONITOR_METRICS_PORT=8080`
  - Resolver only: `RESOLVER_METRICS_PORT=8081`
- [ ] Generate a Railway deploy token → save as `RAILWAY_TOKEN` in GitHub repo secrets.
- [ ] In Railway, enable the services' public domains only if you want external access to `/metrics` and `/healthz` (not required).

## 4. GitHub repo configuration

Set under **Repo → Settings → Secrets and variables → Actions**.

### Repo secrets (encrypted)
- [ ] `SUPABASE_ACCESS_TOKEN`
- [ ] `SUPABASE_DB_PASSWORD`
- [ ] `VERCEL_TOKEN`
- [ ] `VERCEL_ORG_ID`
- [ ] `VERCEL_PROJECT_ID`
- [ ] `RAILWAY_TOKEN`

### Repo variables
- [ ] `SUPABASE_PROJECT_REF` = `sqjdfafewyphoroaivqq`
- [ ] `ENABLE_SUPABASE_DEPLOY` = `true`
- [ ] `ENABLE_VERCEL_DEPLOY` = `true`
- [ ] `ENABLE_RAILWAY_DEPLOY` = `true`

Once set, every push to `main` will apply migrations, deploy edge functions, deploy the web, and deploy the Python workers (in that order; later jobs skip on migrate failure).

## 5. Edge-function env vars

Supabase auto-provides `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` inside edge functions — nothing to add for `place-bet`.

For `check-ledger-invariants`:
- [ ] `DISCORD_WEBHOOK_URL` (same webhook as the resolver — Discord → Edit Channel → Integrations → Webhooks).
  Set via: `supabase secrets set DISCORD_WEBHOOK_URL=... --project-ref sqjdfafewyphoroaivqq`

## 6. Domain and DNS

- [ ] `haltmarket.com` → Vercel.
- [ ] Email: set up `transactional@haltmarket.com` or similar — Supabase Auth uses it for magic links (configure SMTP in Auth → SMTP).

## 7. Compliance / legal (before onboarding real users)

These are **hard blockers** for real-money alpha but can be skipped for a play-money internal beta:

- [ ] KYC vendor integration (Persona, Sumsub, Stripe Identity). Wire into a new `initiate-kyc` edge function that flips `user_profiles.kyc_status` from `pending` → `approved` on vendor callback.
- [ ] Populate `user_profiles.geo_country` at signup (IP-geolocation lookup, or self-attested during KYC — your lawyer will have a view).
- [ ] Review ToS + Privacy Policy with counsel.
- [ ] CFTC preliminary approval scope — confirm which products are in-scope for this alpha.
- [ ] Responsible gambling resources / self-exclusion UI (if applicable in your jurisdictions).

## 8. Seed + verify

Once the above is done:

- [ ] Push to `main`. Watch Actions → `deploy` workflow complete green.
- [ ] In Supabase SQL editor, verify migrations 0001–0007 landed: `select version, name from supabase_migrations.schema_migrations order by version;`
- [ ] In Supabase Functions, verify `place-bet`, `lock-due-markets`, `check-ledger-invariants` are all deployed.
- [ ] In Railway, both services show "Active" with healthy `/healthz`.
- [ ] Hit `https://haltmarket.com/` — should show "No active halts right now" when market is quiet.
- [ ] Sign in via magic link — verify a `user_profiles` row appears once you set a handle (needs a profile flow — this UI is a gap; for now operators can `insert` directly).
- [ ] Manually approve your own user's KYC for testing: `update user_profiles set kyc_status='approved' where user_id='<your-uuid>';`.
- [ ] During market hours, wait for the first LUDP halt, verify the market appears, place a $10 test bet, watch it resolve.

## 9. Observability before traffic

- [ ] Configure Grafana Cloud (or equivalent) to scrape `/metrics` from both Railway services. Key metrics:
  - `haltmarket_monitor_halts_total`
  - `haltmarket_resolver_resolves_total`, `..._refunds_total`, `..._invariant_failures_total`, `..._rehalt_extensions_total`
- [ ] Alert on `haltmarket_resolver_invariant_failures_total > 0` — this means the ledger drifted; freeze `place-bet` and follow `docs/runbook-drift.md`.
- [ ] Set up a Discord channel for webhook posts; confirm resolver + ledger-invariant job both land there.

## Known gaps to close post-alpha

These items exist but are NOT blockers:

- Web Push (Phase 6 — VAPID keys, service worker)
- Deposit/withdrawal (Phase 8 — Stub Provider → Circle/Coinbase)
- Admin panel (Phase 9 — operator tools)
- End-to-end integration harness (Phase 10)
- Profile/handle setup UI (currently ops must insert rows manually)
- Realtime wallet balance updates (wallet refreshes on page nav only)

---

**When everything above is green, you can launch the alpha.** If anything goes sideways during launch, freeze `place-bet` (set a Supabase edge function env var or comment out the route) and reach out on-call.
