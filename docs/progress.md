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
