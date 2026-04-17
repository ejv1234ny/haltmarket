# Claude Code Build Prompt — haltmarket

**How to use this file.** This is the complete project brief. Read it, acknowledge the phase plan, and begin Phase 0. Every phase ends with a merged PR. The final section lists work a human must do — do not attempt those.

---

## Mission

Build **haltmarket**: a real-money prediction market where users bet on the reopening price of NASDAQ stocks after LUDP (Limit Up-Limit Down) trading halts. Think Polymarket, but the only markets are 5-minute halt windows and the bet is on the exact reopen price.

Companion documents in this repo:

- `docs/design.md` — the full system design, read it before Phase 0
- `docs/adrs/ADR-0001-ledger-subsystem.md` — the ledger architecture decision, ground truth for Phases 1-2

Every architectural question is already answered in those two files. If you encounter a new question not covered there, follow the escalation protocol in §7.

## 1. Ground truth

- **Product name:** haltmarket
- **Domain:** haltmarket.com (assume DNS and TLS handled separately)
- **Market mechanism:** parimutuel pool over a 20-bin log-spaced price ladder with a closest-to-the-pin bonus layer (see design doc §4.1 and ADR-0002). Default fee 5%, default closest bonus 7%, remainder to winning bin pro-rata.
- **Launch currency:** USDC only; fiat rails deferred
- **Jurisdiction:** offshore entity, geo-blocking US — you do not handle this, just wire the `geo_country` and `kyc_status` fields so compliance can enforce
- **Fee:** 5% of pool, configurable per market
- **Betting window:** halt_time + 90 seconds, hard server-side enforcement
- **Reopen-price source:** Polygon opening-cross condition code, with first-trade fallback
- **Refund policy:** full refund (no fee) on any unresolved market
- **Supabase project ref:** `gidbmzzbwmodmwlbsngv`

## 2. Tech stack (non-negotiable)

| Layer | Tech |
|---|---|
| Database / auth / realtime | Supabase (hosted Postgres) |
| Backend API | Supabase Edge Functions (Deno/TS) for hot-path; Python (FastAPI) for the halt monitor and resolution worker |
| Frontend | Next.js 14 App Router, TypeScript, Tailwind, shadcn/ui |
| Mobile | PWA via the same Next.js app |
| Monorepo tool | pnpm workspaces + Turborepo |
| Migrations | Supabase CLI (`supabase db push`) |
| Hosting | Railway for Python workers; Vercel for Next.js; Supabase managed for DB + edge |
| CI | GitHub Actions |
| Observability | Supabase logs + a Discord webhook for pages; no Datadog at this stage |
| Market data | Polygon.io REST API (env var `POLYGON_API_KEY`) |
| Halt feed | Nasdaq Trader RSS: `https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts` |
| Push | Web Push (VAPID) via `web-push` npm package |

## 3. Repository layout (create in Phase 0)

```
haltmarket/
├── apps/
│   ├── web/                 # Next.js 14 frontend
│   ├── monitor/             # Python halt ingestor
│   └── resolver/            # Python resolution worker
├── supabase/
│   ├── migrations/          # Versioned SQL
│   ├── functions/           # Deno edge functions
│   │   ├── place-bet/
│   │   ├── notify-halt/
│   │   ├── initiate-deposit/
│   │   └── initiate-withdrawal/
│   └── config.toml
├── packages/
│   ├── shared-types/        # Generated Supabase types + shared TS types
│   └── ledger-client/       # TS client for the ledger RPC layer
├── infra/
│   └── github-actions/      # CI workflows
├── docs/
│   ├── design.md
│   ├── ledger.md            # Double-entry conventions
│   ├── runbook-drift.md     # What to do when the wallet invariant fails
│   ├── progress.md          # Append after each phase
│   ├── human-tasks.md       # Final handoff checklist
│   └── adrs/
│       └── ADR-0001-ledger-subsystem.md
├── .devcontainer/
├── AGENTS.md                # This file
├── README.md
└── package.json
```

## 4. Phase plan — build in strict dependency order

Each phase has a **Goal**, **Deliverables**, **Acceptance**, and **Commit prefix**. Do not start Phase N+1 until Phase N has a merged PR. Open exactly one PR per phase against `main`.

### Phase 0 — Bootstrap

**Goal.** Empty repo → deployable skeleton with CI green.

**Deliverables.** Monorepo structure from §3; Turborepo pipeline; Next.js app rendering "haltmarket" placeholder; Python apps skeleton with `pyproject.toml` + `uv`; Supabase project linked; GitHub Actions for lint/typecheck/test on PR and deploy on merge; `.env.example` listing every secret; README with local-dev instructions.

**Acceptance.** `pnpm install && pnpm build` works from a clean clone. CI passes on the initial PR. `supabase start` runs locally.

**Commit prefix.** `chore(bootstrap):`

---

### Phase 1 — Ledger (follow ADR-0001 exactly)

**Goal.** Ship the financial ledger before any product feature touches money.

**Deliverables.**
- Migration `0001_ledger.sql` creating `wallets`, `ledger_entries`, `deposits`, `withdrawals`
- RLS: no client-side writes to ledger or wallets (service role only)
- SECURITY DEFINER function `post_transfer(txn_id uuid, legs jsonb, reason text)` that validates `sum(amount_micro) = 0`, inserts all legs and updates wallet cache in one `SERIALIZABLE` transaction, rejects duplicate `txn_id`
- `packages/ledger-client` TS wrapper
- Hourly invariant job (scheduled edge function) that verifies `SUM = 0` globally, samples 1000 users for cache consistency, posts Discord alert on discrepancy
- Tests: unit tests per transfer pattern from ADR-0001 appendix; property-based test (10K random sequences preserve invariant); concurrency test (parallel bet placements, no double-spend); failure-injection test (kill mid-transaction, no partial writes)
- CI gate: workflow step that fails if any new migration `UPDATE`s or `DELETE`s `ledger_entries`
- `docs/ledger.md` with the five canonical transfer patterns

**Acceptance.** All tests green, ≥95% coverage on ledger module. Invariant job runs and heartbeats. Migration replayable on a fresh Supabase branch.

**Commit prefix.** `feat(ledger):`

---

### Phase 2 — Halt ingestion

**Goal.** Detect LUDP, T1, T12, and H10 halts from the Nasdaq RSS feed within 5 seconds of publication. LUDP is pure volatility; T1 and T12 are news halts (filing / dissemination); H10 is regulatory. All four are valid halt events for market creation.

**Deliverables.** `apps/monitor/` Python service with 3-second RSS poll cadence filtered to LUDP; dedup via persisted seen-set; migration `0002_halts.sql`; Polygon fetch for `last_price` at halt time; hot-standby leader election via `pg_try_advisory_lock`; `/metrics` endpoint; Dockerfile for Railway; integration test against a recorded RSS fixture.
- Reason-code filter accepts {LUDP, T1, T12, H10}; emits a structured `halt_kind` field on `halts` (one of `volatility`, `news`, `regulatory`) so downstream phases can classify "hot vs boring" without re-parsing the RSS.

**Acceptance.** Running locally against live Nasdaq RSS captures every LUDP that Polygon independently shows in a 1-hour window. Halt-to-DB p95 < 5s. Killing the leader causes standby takeover within 10s.

**Commit prefix.** `feat(monitor):`

---

### Phase 3 — Market lifecycle engine

**Goal.** On every new halt, atomically create a market with a 20-bin ladder open for bets.

**Deliverables.** Migration `0003_markets.sql` creating `markets`, `bins`, `bets`, `market_resolutions`, `payouts`; RLS: bets readable by owner + public aggregates; Postgres trigger on `halts` INSERT → `create_market(halt_id)` SECURITY DEFINER function; 20 log-spaced bins from `last_price × 0.5` to `last_price × 2.0` plus tail bins; `closes_at = halt_time + 90s`; status state machine (`open` → `locked` → `resolved` | `refunded`) enforced via trigger; scheduled function (every 15s) transitions `open` → `locked` at `closes_at`; unit tests covering ladder generation for penny stocks, large-caps, and price edge cases.
- `markets.closest_bonus_bps int not null default 700` column (tunable per-market)
- No change to bin construction — still 20 log-spaced bins plus tail bins

**Acceptance.** Inserting a halt produces a market + 20 bins atomically. Market locks automatically at `closes_at`. Ladder tests pass for price range $0.10–$10,000.

**Commit prefix.** `feat(market):`

---

### Phase 4 — Bet placement (hot path)

**Goal.** Ship the `place-bet` edge function with all correctness properties.

**Deliverables.**

- Accept `{ market_id, predicted_price numeric(12,4), stake_micro, idempotency_key }` (no more `bin_id` — the server derives it from `predicted_price`)
- Server-side: look up the bin whose `[low_price, high_price)` contains the predicted price; reject if predicted_price is outside the ladder extremes
- Store both `predicted_price` and `bin_id` on the `bets` row
- Schema addition: `bets.predicted_price numeric(12,4) not null`

Inside one SERIALIZABLE transaction: assert `market.status = 'open'` + `now() < closes_at`, assert `wallets.balance_micro ≥ stake_micro`, assert `idempotency_key` is new for `(user, market)`, call `post_transfer` with `(−) user_wallet, (+) market_pool`, insert `bets` row, increment `bins.stake_micro` + `markets.total_pool_micro`; rate limit 10 bets/sec per user + $1000 max stake per market per user; realtime broadcast on bins deltas; 4xx error taxonomy (`market_closed`, `insufficient_balance`, `duplicate_idempotency_key`, `rate_limited`); E2E test with 100 concurrent bets.

**Acceptance.** p95 < 500ms under 100 concurrent users. No double-spends in 100K-iteration stress test. Ledger invariant holds after the stress test.

**Commit prefix.** `feat(bet):`

---

### Phase 5 — Resolution worker

**Goal.** Detect reopens via Polygon and settle markets deterministically.

**Deliverables.** `apps/resolver/` Python service polling every 5s; for locked markets with `halt_end_time < now() - 5s`: query Polygon `/v3/trades/{symbol}` preferring opening-cross condition code, fall back to first regular trade, refund after 15 min without data; on capture: execute the Resolution math block below, write `market_resolutions`, `post_transfer` with all legs in one txn, insert `payouts`, mark `resolved`; idempotent (restart-safe); handle re-halt scenario (extend wait); integration test with 5 historical Polygon fixtures.

**Resolution math (per ADR-0002):**

Given captured `reopen_price`, compute:

1. `gross_pool = markets.total_pool_micro`
2. `fee = gross_pool × (markets.fee_bps / 10000)`
3. `bonus = gross_pool × (markets.closest_bonus_bps / 10000)`
4. `main_pool = gross_pool − fee − bonus`
5. Find `winning_bin`: bin where `low_price ≤ reopen_price < high_price`, or the appropriate tail bin for extremes
6. Find `closest_user`: the user with smallest `|predicted_price − reopen_price|` across ALL bets on this market (not just winning-bin bets). Tie-break: split the bonus equally among tied users
7. For each bet in `winning_bin`: `payout = main_pool × (bet.stake_micro / winning_bin.stake_micro)`
8. Build a single `post_transfer` with legs:
   - `(−) market_pool`: gross_pool
   - `(+) house_fees`: fee
   - `(+) user_wallet` (closest user): bonus
   - `(+) user_wallet` (each bin winner): their pro-rata share
9. Mark `market.status = 'resolved'`, write `market_resolutions` row with `closest_bonus_winner_user_id` and `closest_bonus_amount_micro`

**Acceptance.** Synthetic test: inject halt + reopen, winner gets expected payout to the micro. Mean settlement < 30s from `halt_end_time`. Idempotency test: kill mid-resolution, restart, no double-pay.
- Single-closest-winner payout is deterministic and replayable
- Tie-breaking: if N users tie exactly, each gets `bonus / N`
- Closest winner can also be a bin winner; both payouts credit the same user_wallet in the same resolution txn
- If no bettor submitted a `predicted_price` (shouldn't happen but guard anyway), the bonus folds into `main_pool`

**Commit prefix.** `feat(resolver):`

---

### Phase 6 — Notifications

**Goal.** When a market opens, fan out push notifications within 5s.

**Deliverables.** Migration `0004_notifications.sql` for `notification_prefs`, `push_subscriptions`, `notification_log`; VAPID key generation script (operator holds keys); Web Push subscription API in frontend; Supabase trigger on `markets` INSERT → edge function `notify-halt`; parallel `web-push` dispatch with per-endpoint circuit breakers + DLQ; email channel stub (SendGrid) — interface wired, credentials blank until operator provides; observability: delivery rate, p95 latency, DLQ depth.

**Acceptance.** Synthetic: insert halt, push arrives on test subscription within 5s. Handles 10K subscribers without timeout.

**Commit prefix.** `feat(notify):`

---

### Phase 7 — Frontend

**Goal.** Ship the user-facing app: market list, live market detail, bet placement, wallet, history, leaderboard.

**Deliverables.** Next.js 14 App Router pages (`/`, `/market/[id]`, `/wallet`, `/history`, `/leaderboard`); Supabase auth (email + magic link + Google OAuth); realtime subscriptions to `markets:{id}` and `user:{id}` channels; mobile-first PWA with shadcn/ui dark mode; Playwright smoke tests; Vercel deploy with PR previews.
- Bet placement UI: numeric price input (4-decimal precision), not bin selection. On keystroke, client renders "Your guess: $X.XX · bin $A.AA–$B.BB" as visual confirmation of the auto-map. A collapsed "view ladder" disclosure reveals the full 20-bin view for power users.
- Receipt on successful bet: "Your guess: $X.XX · Stake: $Y" (bin not shown unless expanded).
- Resolution screen: "You won $Z.ZZ" with expandable breakdown: "$A.AA for correct zone · $B.BB closest-to-the-pin bonus" when applicable.

**Acceptance.** User can sign up → see open markets → place a bet → see live pool updates → see resolution → see payout in wallet. Lighthouse performance ≥90 on `/market/[id]`. Playwright green.

**Commit prefix.** `feat(web):`

---

### Phase 8 — Deposit / withdrawal scaffolding

**Goal.** Wire the flow end-to-end with a pluggable `PaymentProvider` interface. Do not integrate real money rails.

**Deliverables.** TS interface `PaymentProvider { initiateDeposit, confirmDeposit, initiateWithdrawal, confirmWithdrawal }`; `StubProvider` that credits after 5s delay; edge functions `initiate-deposit`, `initiate-withdrawal`; webhook `/api/webhooks/payments` with HMAC verification; UI flows on `/wallet` using the stub in dev; `TODO(human): swap StubProvider for Coinbase Commerce / Circle / Fireblocks` markers where real integration goes.

**Acceptance.** Deposit with StubProvider credits wallet after delay. Withdrawal debits immediately. Ledger invariants hold after 1000 simulated cycles.

**Commit prefix.** `feat(payments):`

---

### Phase 9 — Admin / observability / runbooks

**Goal.** Operator tools + production-grade monitoring.

**Deliverables.** Admin-gated `/admin` page (`users.role = 'admin'`): force-refund a market, view ledger totals, rebuild wallet cache, view invariant-check history; dashboard of halt latency, bet latency, resolution success rate, notification delivery rate, DLQ depth, open markets; Discord alerts for ledger invariant failure, DLQ >100, resolution <95% in last hour, market stuck in locked >20 min; runbooks: `runbook-drift.md`, `runbook-stuck-market.md`, `runbook-rss-outage.md`, `runbook-polygon-outage.md`.

**Acceptance.** Admin can force-refund and ledger balances. Every alert path tested by intentionally breaking the invariant.

**Commit prefix.** `feat(admin):` + `docs(runbook):`

---

### Phase 10 — End-to-end integration

**Goal.** Single test exercising the full pipeline (only Nasdaq RSS + Polygon mocked).

**Deliverables.** Playwright + Supabase harness: seed user with balance → inject halt via RSS fixture → wait for market → place bet → wait for lock → inject reopen via Polygon fixture → assert winner payout → assert `SUM = 0` on ledger → assert fee landed in `house_fees`.

**Acceptance.** E2E passes 100 iterations in a row without flake. Runs on every PR to `main`.

**Commit prefix.** `test(e2e):`

---

## 5. Autonomy rules

1. **One phase at a time.** Do not start Phase N+1 until N has a merged PR.
2. **One PR per phase.** Title: `[Phase N] <short name>`. Body: Deliverables checklist + green Acceptance section.
3. **Tests are part of the phase.** Skipped tests = phase incomplete.
4. **Migrations are additive only.** New column = new migration. Never alter or drop.
5. **Never touch the ledger schema outside Phase 1.** New money types = new `reason` enum value, not new column.
6. **Edge functions ≤ 200 lines.** If larger, factor.
7. **Type everything.** `any` in TS, missing Python type hints → CI fails.
8. **No feature flags for money features.** A ledger bug behind a flag is still a ledger bug. Gate unfinished features in the UI only.
9. **Secrets via env vars only.** Never commit keys. `.env.example` lists every var.
10. **Conventional Commits.** `feat(scope):`, `fix(scope):`, `chore(scope):`, `test(scope):`, `docs(scope):`.

## 6. Quality gates

Every PR must pass: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `supabase db lint` · ledger-mutation grep check · Playwright smoke tests (Phase 7+).

## 7. Escalation protocol

1. **Decide if obvious and reversible.** Document in PR description.
2. **Stop and open a GitHub issue** if the decision is: public API contract, ADR-0001 deviation, ledger schema change, new external dependency (>1MB npm or new SaaS), security-sensitive.
3. **Issue format.** Title `[HUMAN] <one-line question>`. Body: 3-5 sentence context + 2-3 options with trade-offs + your recommendation. Label `needs-human`.
4. **Do not block on the issue.** Skip the affected slice, proceed with your recommended option marked `TODO(human)`, move to next phase. Batched resolution later.

## 8. Progress reporting

After each phase merge, append to `docs/progress.md`:

```
## Phase N — <name>
- Merged: <date>
- PR: #<number>
- Tests added: <count>
- Open questions escalated: <count>
- Notes: <2-3 sentences>
```

At session start, output the current phase and next concrete sub-task. At session end, output what shipped and what the next session starts with.

## 9. Human-required items — DEFERRED, DO NOT ATTEMPT

Stub interfaces where code touches them; mark `TODO(human):` with a link here.

1. **Legal entity formation.** Offshore jurisdiction selection (Cayman, Curaçao, Anjouan), registration, gaming license.
2. **Regulatory classification.** CFTC registration vs offshore-only vs sweepstakes. Counsel decision.
3. **Terms of Service + Privacy Policy.** Lawyer-drafted. Do not generate.
4. **KYC vendor selection.** Persona, Sumsub, Veriff, Onfido — commercial decision.
5. **Payment processor integration.** Coinbase Commerce / Circle / Fireblocks for USDC. Merchant agreement + KYB required. Plug into `StubProvider` from Phase 8.
6. **Banking / treasury.** Wallet addresses, custody, multi-sig policy. Human sign-off.
7. **Polygon.io paid tier.** Real-time trades entitlement. Data agreement.
8. **Nasdaq data licensing.** If moving off RSS to SIP direct — Nasdaq data license.
9. **Domain / DNS / email.** Register haltmarket.com, DKIM/SPF/DMARC, Cloudflare.
10. **Geo-blocking policy.** Which jurisdictions are blocked — legal decision.
11. **Responsible gambling tooling.** GamStop, self-exclusion vendor — operator's call.
12. **Insurance.** Cyber liability, tech E&O, crime — broker call.
13. **Smart-contract audit.** If migrating to on-chain custody — Trail of Bits / OpenZeppelin.
14. **VAPID key generation.** Operator generates, stores, loads via env.
15. **Admin user provisioning.** First admin created manually in Supabase.
16. **Tax handling.** 1099 generation for US users (if accepted) — CoinTracker/TaxBit integration.
17. **Marketing site content.** Landing-page copy, brand voice, imagery — human writer.
18. **Incident communications templates.** PR decision.
19. **Bug bounty program.** HackerOne / Immunefi setup — operator decision.
20. **Production deploy sign-off.** Human reads the launch checklist and signs off.

## 10. Definition of done

Build is complete when:
- Phases 0-10 all merged to `main`
- E2E test from Phase 10 passes 100 iterations in CI
- Fresh contributor can clone + run full stack locally in <30 min via README
- All `TODO(human)` markers catalogued in `docs/human-tasks.md` with line references
- `docs/progress.md` reflects every phase
- No PR has unresolved review comments
- `needs-human` issue queue is the operator's only remaining blocker to launch

At this state, stop. Post a final comment summarizing the build (total test count, LOC, open questions, ordered `docs/human-tasks.md`).

---

*Begin with Phase 0. Do not ask for confirmation — this file is the confirmation.*
