Resume the haltmarket build. Phases 0-3 and Phase 7 (frontend-mocked) are merged on main. Phase 4 is next.

Build Phase 4 per AGENTS.md §Phase 4, as amended by ADR-0002. The amendments already landed in Phase 3's migration 0003_markets.sql — `bets.predicted_price numeric(12,4) not null` and `markets.closest_bonus_bps int` are live.

## Deliverables

Ship the `place-bet` Supabase Edge Function with these properties:

### Request shape
`{ market_id, predicted_price, stake_micro, idempotency_key }`
- `predicted_price` is `numeric(12,4)` (4-decimal precision from ADR-0002 UX contract)
- `stake_micro` is bigint (microdollars)
- `idempotency_key` is uuid
- NO `bin_id` in the request — derive it server-side

### Server-side derivation
1. Look up the bin containing `predicted_price` via the `find_bin_for_price(market_id, price)` RPC from Phase 3. Reject if price is outside ladder extremes (below tail-low or above tail-high).
2. Store BOTH `predicted_price` and derived `bin_id` on the `bets` row.

### Inside one SERIALIZABLE transaction
- Assert `markets.status = 'open'` AND `now() < markets.closes_at`.
- Assert `wallets.balance_micro >= stake_micro`.
- Assert `idempotency_key` is unique for `(user_id, market_id)`.
- Call `post_transfer(txn_id => gen_random_uuid(), legs => [(-) user_wallet, (+) market_pool], reason => 'bet_placed')` from the Phase 1 ledger. Pass the stake as two balanced legs (sum = 0).
- Insert the `bets` row with `predicted_price`, `bin_id`, `stake_micro`, `idempotency_key`.
- Increment `bins.stake_micro` for the derived bin and `markets.total_pool_micro`.

### Rate limits (enforced server-side)
- 10 bets/sec per user (sliding window, Redis-style table OR pg advisory lock).
- $1000 max aggregate stake per market per user.

### Realtime broadcast
On successful bet, publish to `markets:{market_id}` channel with `{type:'bin_delta', bin_id, new_stake_micro, new_total_pool_micro}`. Phase 7 frontend is already subscribed.

### 4xx error taxonomy
`market_closed` · `insufficient_balance` · `duplicate_idempotency_key` (return existing bet receipt — idempotent) · `rate_limited` · `exceeds_per_market_limit` · `price_outside_ladder` · `invalid_price_precision` · `market_not_found`

### Edge function constraints
- ≤ 200 lines. If larger, factor into `supabase/functions/_shared/`.
- No `any` in TS.
- Must run against Deno/edge runtime (no Node-only APIs).

### Tests
- Unit tests in `@haltmarket/markets-client` (extend the Phase 3 package): bet validation, error mapping, idempotency.
- Integration tests in `scripts/ledger-integration.sh` (this is already the glob-all script, just add tests to the markets-client integration suite): insert halt → market opens → place 10 bets (winning, outside ladder, duplicate keys) → assert ledger invariant holds.
- Concurrency test: 100 concurrent bets same user (rate limit), 100 concurrent from 100 users (all succeed). Assert `ledger_global_sum() = 0` after.
- Stress test: 100K iteration random bet sequence → ledger invariant must hold.

## Acceptance

- p95 < 500ms under 100 concurrent users on `place-bet`.
- No double-spends in 100K-iteration stress test.
- Ledger invariant (SUM = 0) holds after stress test.

## Non-goals (Phase 5+)

- Do NOT resolve markets. Phase 5.
- Do NOT refund markets. Phase 5.
- Do NOT implement push notifications on bet-placed — Phase 6.
- Phase 7 frontend swap from mocks is a separate PR after Phase 5 lands.

## Commit prefix

`feat(bet):` per AGENTS.md §5 rule 10.

## PR

Open one PR against main titled `[Phase 4] Bet placement (place-bet edge function)`. Include the Deliverables + Acceptance checklists in the PR body. Append a `## Phase 4` section to `docs/progress.md` in a separate follow-up PR after merge (matches the existing Phase 0/1/2 pattern).
