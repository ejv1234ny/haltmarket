Resume the haltmarket build. Phase 4 (`place-bet` edge function) is merged on main. Users can now place bets, and `bets` + `bins` + `markets` accumulate stake.

**CRITICAL**: AGENTS.md §Phase 5 is STALE on the resolution math — it predates ADR-0002. The ground truth for Phase 5 math is **ADR-0002 §Resolution Math** (closest-to-the-pin bonus layer). This prompt encodes the amendment.

## Deliverables

Ship `apps/resolver/` — a Python service (`uv` managed) that resolves locked markets.

### Polling loop
- Poll every 5 seconds.
- For each market where `status = 'locked'` AND `halt_end_time < now() - 5s`:
  1. Query Polygon `/v3/trades/{symbol}` starting at `halt_end_time`.
  2. Prefer the trade with opening-cross condition code.
  3. Fall back to the first regular trade after `halt_end_time` if no opening-cross within a 2-minute window.
  4. If no data after 15 minutes, transition market to `refunded` and refund all bets via a single `post_transfer`.

### Resolution math (from ADR-0002 — AMENDS AGENTS.md §Phase 5)

Given captured `reopen_price`:

1. `gross_pool = markets.total_pool_micro`
2. `fee = gross_pool × (markets.fee_bps / 10000)` — default 5% = 500 bps
3. `bonus = gross_pool × (markets.closest_bonus_bps / 10000)` — default 7% = 700 bps
4. `main_pool = gross_pool − fee − bonus`
5. `winning_bin`: bin where `low_price ≤ reopen_price < high_price`, or the appropriate tail bin.
6. `closest_user`: smallest `|predicted_price − reopen_price|` across ALL bets on this market (not just winning-bin). Ties split `bonus / N`.
7. For each bet in `winning_bin`: `payout_i = main_pool × (bet_i.stake_micro / winning_bin.stake_micro)`.
8. Single `post_transfer` with legs (sum = 0):
   - `(−) market_pool`: `gross_pool`
   - `(+) house_fees`: `fee`
   - `(+) user_wallet` (each closest-user tied): `bonus / N` each
   - `(+) user_wallet` (each bin winner): their pro-rata share
9. Mark `market.status = 'resolved'`.
10. Write `market_resolutions` row with `reopen_price`, `winning_bin_id`, `closest_bonus_winner_user_id` (or array if tied), `closest_bonus_micro`, `fee_micro`, timestamp.

### Edge cases
- Closest winner can also be a bin winner — DO NOT deduplicate; two semantically different payouts.
- No bettor submitted predicted_price → fold bonus into main_pool, no closest winner recorded.
- Re-halt on first trade → extend wait by 5 min before refund-timeout.
- Restart safety: on boot, re-fetch all markets in `locked` OR `resolved`/`refunded`-with-missing-resolutions. Idempotency key = `(halt_id, 'resolved'|'refunded')`.

### Leader election
Same pattern as Phase 2 monitor: `pg_try_advisory_lock('resolver-leader')`. Hot-standby takes over within 10s.

### Observability
- `/metrics` endpoint: resolves/hour, refund rate, p95 settlement latency.
- Discord webhook on: refunds, resolves > 120s, `SUM ≠ 0` after resolve (CRITICAL — page).

### Tests
- Integration in `apps/resolver/tests/`:
  - Inject halt → market opens → bets → lock → resolve → assert payouts match math to the micro.
  - Five Polygon fixtures: opening-cross resolve, first-trade fallback, 15-min refund, re-halt extension, reopen-on-bin-boundary.
  - Idempotency: kill mid-resolve, restart, no double-pay.
- Property-based: random bet sequences → resolver → `SUM = 0` always.

## Acceptance
- Synthetic: winner gets expected payout to the **micro** (not cent).
- Mean settlement < 30s from `halt_end_time`.
- Idempotency test passes 100×.
- Single-closest-winner deterministic + replayable.

## Non-goals
- Push notifications — Phase 6.
- Admin force-refund UI — Phase 9.
- Frontend swap from mocks — do in phase-7-cleanup prompt.

## Commit prefix
`feat(resolver):`

## PR
Title: `[Phase 5] Resolution worker (with ADR-0002 closest-to-pin bonus math)`. Body must explicitly call out that this amends AGENTS.md §Phase 5 with ADR-0002 math. Include the 10-step math block verbatim.
