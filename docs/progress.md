# Progress log

Appended after each phase's PR merges. Format per `AGENTS.md` §8.

## Phase 7 — Frontend (mocked data)
- Merged: pending
- PR: (opened from `phase-7-frontend-mocked`)
- Tests added: 10 bin-math unit tests + 4 Playwright smoke specs (×2 projects = 8 runs)
- Open questions escalated: 0
- Notes: Next.js 14 App Router pages (`/`, `/market/[id]`, `/wallet`, `/history`, `/leaderboard`, `/sign-in`), shadcn-style primitives, Supabase auth (`@supabase/ssr`: magic-link + Google OAuth), PWA manifest + SVG mark, mock data layer with pub/sub realtime channels. Bet UI implements the ADR-0002 hybrid mechanic: guess-the-price input with inline "bin $A–$B" preview, dual estimates for the zone share (main pool, 88% default) and closest-to-pin bonus (7% default). Resolved-market view shows headline payout with an expandable zone + bonus breakdown. 20-bin ladder lives behind a disclosure toggle. All mock types carry `TODO(phase-3/4/5)` markers; swap-out is a pure data change once Codespace A lands the real schema. Playwright wired into CI via the official `mcr.microsoft.com/playwright` image.

## Phase 0 — Bootstrap
- Merged: 2026-04-16
- PR: #2
- Tests added: 3 Node (2 ledger-client balance assertions + 1 web smoke) + 2 Python (monitor + resolver smoke)
- Open questions escalated: 0
- Notes: Monorepo, Turbo pipeline, Next.js 14 placeholder, Python skeletons (uv), Supabase local config, GitHub Actions CI with the ledger-mutation grep guard already active, gated deploy-on-merge stubs, full `.env.example`, local-dev README. All five CI jobs green on first push. No money-movement code yet — that starts in Phase 1 per ADR-0001.

## Phase 1 — Ledger (ADR-0001)
- Merged: 2026-04-17
- PR: #4
- Tests added: 36 (25 unit + 11 integration in `@haltmarket/ledger-client`)
- Open questions escalated: 0
- Notes: Append-only double-entry ledger shipped via `0001_ledger.sql` (wallets, ledger_entries, deposits, withdrawals, four SECURITY DEFINER RPCs: `post_transfer`, `reconcile_wallet_cache`, `ledger_global_sum`, `ledger_wallet_drift`). `@haltmarket/ledger-client` wraps the RPCs with a typed `LedgerError` taxonomy (`duplicate_txn_id | unbalanced_legs | overdraft | invalid_leg | transport`). Hourly `check-ledger-invariants` edge function verifies global SUM=0 and samples 1000 wallet rows for cache drift, paging Discord on discrepancy. CI grows a `postgres:17-alpine` service for migration + integration; ledger-mutation grep guard remains active. Coverage 99.13% lines / 91.07% branches on the client module. Supabase `major_version` bumped 15 → 17 for `UNIQUE NULLS NOT DISTINCT` support. No money-movement features yet — Phases 2+ build on this foundation.

## Phase 2 — Halt ingestion (LUDP + T1 + T12 + H10)
- Merged: 2026-04-17
- PR: #7 (ADR-0002 amended the scope; docs PR #5, progress PR #6)
- Tests added: 34 (13 classify + 9 feed fixture + 6 poller + 5 DB integration + 1 smoke preserved)
- Open questions escalated: 0
- Notes: `apps/monitor` Python service now runs a 3-second RSS poll loop, enriches halts with Polygon `/v2/last/trade`, and inserts via `public.insert_halt(...)` (idempotent, `ON CONFLICT DO NOTHING` on `UNIQUE (symbol, halt_time, reason_code)`). Hot-standby leader election via `pg_try_advisory_lock` on a dedicated psycopg session; takeover on leader death is immediate on the next tick. Migration `0002_halts.sql` adds the `halt_reason_code` + `halt_kind` enums and a stored generated `halts.halt_kind` column driven by an immutable classifier function — so downstream phases filter "hot vs boring" without re-parsing RSS. `/metrics` + `/healthz` on :8080 (prometheus text format, stdlib http.server, no prometheus_client dep). Dockerfile targets `python:3.12-slim` with a two-stage uv build. CI's `python lint + typecheck + test (monitor)` job now ships a `postgres:17-alpine` service and applies every `supabase/migrations/*.sql` so the 5 live-pg integration tests actually run in CI.

## Phases 6 + 7 polish, 8, 9, 10 — alpha-wiring bundle
- Merged: pending (PR #20 `feat/alpha-wiring-phases-6-7-8`)
- Tests added: +22 TS integration (crypto RPCs, admin gates, orphan rescue, E2E flow + 50-iter stress), +3 resolver re-halt, +9 resolver alert retry, +18 deposit-watcher signature/schema, +3 web routes smoke-tested
- Open questions escalated: 0
- Notes:
  - **Phase 7 polish**: swapped every mocked read for real Supabase queries (`lib/markets/queries.ts`), wired `bet-form` to the `place-bet` edge function with idempotency keys + typed error codes, added realtime wallet balance via `postgres_changes` on `public.wallets` (migration 0012), `/profile` page + handle-form + email-notify toggle, `/admin` console (withdrawal queue, freeze switches, reconciliation with on-chain viem read), `/admin/users` (search, grant/revoke admin, KYC override), `/admin` orphan section (bind + credit or ignore).
  - **Phase 6 web push + email**: `push_subscriptions` table (migration 0014), `/api/push/subscribe` route, `public/sw.js` service worker, `SubscribeButton` on home page. `notify-halt` edge function fans out to Web Push subscribers and to email opt-ins via Resend (migration 0015 adds `user_profiles.notify_email_on_halt`). VAPID + Resend keys are human-provided at deploy time.
  - **Phase 8 crypto rail**: migrations 0008–0011, 0013, 0016, 0017. Tables: `system_flags`, `user_wallet_addresses`, `crypto_orphan_deposits`, `push_subscriptions`, `compliance_settings` (extended with crypto caps), `user_profiles` (extended with `is_admin` + `notify_email_on_halt`). RPCs: `credit_crypto_deposit` (Base USDC, idempotent on tx_hash, lifetime cap, freeze-aware), `request_withdrawal` + `mark_withdrawal_paid` + `mark_withdrawal_failed`, `reconcile_crypto_ledger`, `record_orphan_deposit` + `admin_rescue_orphan_deposit` + `admin_ignore_orphan_deposit`, `assert_is_admin` + `set_system_flag` + `admin_mark_withdrawal_paid` + `admin_mark_withdrawal_failed`, `admin_list_users` + `admin_set_user_admin` + `admin_override_kyc`, `register_wallet_address`, `get_admin_withdrawal_queue`, `apply_kyc_decision`. New TS service `apps/deposit-watcher` consumes Alchemy Notify webhooks, verifies HMAC, calls `credit_crypto_deposit` or `record_orphan_deposit`. `/wallet` page gains deposit (QR + Privy embedded-wallet address + history) and withdraw (form + address validation + pending list) cards. `request-withdrawal` edge function mirrors `place-bet` error shape.
  - **Phase 9 admin/obs**: Grafana dashboard JSON (`ops/grafana/{monitor,resolver,deposit-watcher}.json`) + scrape config + alert rule template (README). Runbooks: `docs/runbook-drift.md` (pre-existing), `docs/runbook-crypto-drift.md`, `docs/runbook-orphans.md`. `reconcile-crypto` scheduled edge function compares ledger custody to on-chain Safe balances, auto-freezes deposits and posts Discord on breach > $1. `check-ledger-invariants` was already in place from Phase 1.
  - **Phase 10 E2E**: `packages/ledger-client/src/e2e-flow.integration.test.ts` drives halt → market → bet → resolve → payout + refund path + 50-iter stress loop, asserting `ledger_global_sum() = 0` at every step. Tunable via `E2E_ITERATIONS`.
  - **Misc polish**: Next.js bumped to 14.2.35 for CVE-2025-55184/67779, resolver ruff TC001-003 scoped off tests, mypy strict cast in resolver `db.py`, deposit-watcher monorepo registration, Railway config for the third service, `docs/alpha-launch-checklist.md` updated with crypto + KYC + notifications sections. Three KYC vendor parsers shipped behind `KYC_VENDOR` env: `stub` (for dev), `persona`, `sumsub`, `stripe`; all reuse `apply_kyc_decision`. `initiate-kyc` verifies signatures (Persona `t=,v1=` scheme, Sumsub `X-Payload-Digest`, Stripe `Stripe-Signature`) with 5-minute skew windows + timing-safe hex compare.
