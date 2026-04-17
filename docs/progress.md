# Progress log

Appended after each phase's PR merges. Format per `AGENTS.md` §8.

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
