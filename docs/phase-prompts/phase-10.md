Resume the haltmarket build. Phases 0-9 and Phase 7-cleanup are merged. Phase 10 is the final phase.

Build Phase 10 per AGENTS.md §Phase 10.

## Deliverable

A single Playwright + Supabase test in `apps/web/e2e/full-pipeline.spec.ts` that exercises the entire pipeline end-to-end:

1. **Seed** — create a test user, deposit $100 via StubProvider (Phase 8), assert wallet balance = 100_000_000 micro
2. **Inject halt** — post a LUDP halt via the Nasdaq RSS fixture in apps/monitor (fixture already exists from Phase 2)
3. **Wait for market** — Phase 3's trigger should create a market + 22 bins atomically within 5s of halt_time
4. **Place a bet** — via the UI (not direct API). Enter `predicted_price = last_price × 1.1` + $10 stake. Assert success banner + bin-preview shows the expected bin
5. **Wait for lock** — Phase 3's `lock_due_markets()` scheduler should transition market to 'locked' at `closes_at = halt_time + 90s`
6. **Inject reopen** — post a Polygon opening-cross fixture with a reopen price in the test bet's bin
7. **Wait for resolve** — Phase 5's resolver should transition market to 'resolved' within 30s
8. **Assert payouts**:
   - Test user's wallet credited with their pro-rata main-pool share (if bet was in winning bin)
   - Test user credited with closest-to-pin bonus (if their predicted_price was the closest across all bets)
9. **Assert ledger invariant** — `SELECT public.ledger_global_sum()` returns 0
10. **Assert fee** — `house_fees` wallet balance increased by exactly `gross_pool × fee_bps / 10000`

## CI integration

Update `.github/workflows/ci.yml`:
- Add a new `e2e-full-pipeline` job
- Runs in matrix with 3 parallel shards to catch flakes early
- Requires all other jobs pass first
- Blocks main branch merges

## Acceptance

Test must pass **100 iterations in a row** without a single flake. Add a `scripts/e2e-100x.sh` that runs the test 100 times locally for pre-merge verification.

## Non-goals
- Multi-user concurrent bets (Phase 4 stress tests already cover)
- Real Polygon / Nasdaq network — use fixtures only
- Load testing (separate concern, not launch-blocking)
- Mobile E2E (web only for alpha)

## Commit prefix
`test(e2e):`

## PR title
`[Phase 10] Full-pipeline E2E harness (100-iteration flake-free)`

## After merge

The autonomous build is **complete**. Append a final entry to `docs/progress.md` summarizing the entire build: total phases merged, total tests added across the 11 phases, LOC count. Post a final comment on this PR with the build summary + link to `docs/human-tasks.md` which is now the operator's launch checklist.
