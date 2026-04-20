# Progress log

Appended after each phase's PR merges. Format per `AGENTS.md` §8.

## Phase 3 — Market lifecycle engine (amended by ADR-0002)
- Merged: 2026-04-19
- PR: #10 (squash)
- Tests added: 14 ladder unit tests + 25 markets-client integration tests (pg17)
- Open questions escalated: 0
- Notes: Migration `0003_markets.sql` creates `markets`, `bins`, `bets`, `market_resolutions`, `payouts`. 22-bin ladder (1 tail-low + 20 log-spaced main + 1 tail-high, range `last_price × 0.5 → × 2.0`). Status state machine `open → locked → resolved | refunded` enforced via `markets_enforce_status_transition` BEFORE UPDATE trigger + `markets.status_timestamps` CHECK. `lock_due_markets()` RPC + edge function locks expired-open markets every 15s using `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent resolves don't block the batch. `create_market()` Postgres trigger on `halts` INSERT is gated to `halt_kind = 'volatility'` (launch scope: LUDP only; T1/T12/H10 stay ingested but non-tradable at v1 — expanding is a one-line migration). Schema carries ADR-0002's `markets.closest_bonus_bps int not null default 700`, `bets.predicted_price numeric(12,4) not null`, and `market_resolutions.closest_bonus_winner_user_id uuid` + `closest_bonus_micro bigint` for Phase 5 to consume. Pure-TS `computeBinLadder` mirrors the SQL so the bet UI renders the "Your guess $X · bin $A–$B" preview without a DB round-trip; integration tests assert byte-for-byte agreement across $0.10–$10,000. `find_bin_for_price` RPC ready for Phase 4. PR also includes a one-line Playwright test fix (`click ladder-toggle before asserting bin-ladder visibility`) to keep main green — PR #8 had landed the ladder as a disclosure UI but its e2e asserted visibility without opening it.

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
