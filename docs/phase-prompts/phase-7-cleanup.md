Phase 7 shipped with mocks in PR #8 — `TODO(phase-3/4/5)` markers throughout. Phases 3, 4, 5 now merged. Swap mocks for real Supabase queries.

Do NOT introduce new features. Do NOT touch UI components unless a field name changed. Pure data-layer substitution.

## Scope

1. `apps/web/lib/data/*.mock.ts` (or equivalent) → replace each with a real Supabase query. Component signatures do not change.
2. In-memory pub/sub → Supabase Realtime `markets:{market_id}` and `user:{user_id}` channels.
3. Verify each TODO marker:
   - `TODO(phase-3)` — backed by markets/bins/bets/market_resolutions from migration 0003.
   - `TODO(phase-4)` — backed by `place-bet` edge function.
   - `TODO(phase-5)` — backed by market_resolutions + payouts.

## Pages to verify
- `/` — landing + recent-markets feed
- `/market/[id]` — live bin aggregates, place-bet flow hits Phase 4 edge function, resolution view when `status = 'resolved'`
- `/wallet` — real ledger_entries + wallets
- `/history` — real bets + resolution outcomes
- `/leaderboard` — aggregate with min-bet threshold (≥5 bets)

## Rules
- All reads through `@haltmarket/shared-types` + `@haltmarket/web-data` helpers. Don't sprinkle `.from()` calls across components.
- Server components use service role ONLY for aggregations over all users; client components use anon + RLS.
- place-bet call goes through the Phase 4 edge function, not direct table insert.
- Realtime subscription lifecycle tied to mount/unmount; no leaks.

## Tests
Update the 4 Playwright smoke specs to work against real data (seed fixtures in beforeAll). Add ONE new spec: closest-to-pin bonus display on a resolved market — "Bin: $X.XX · Bonus: $Y.YY (closest prediction)".

## Out of scope
New features, visual redesign, mobile optimizations, Phase 6 notification wiring.

## Commit prefix
`refactor(web):` for mock removal. `feat(web):` if genuinely new UI bits needed.

## PR
Title: `[Phase 7 cleanup] swap mocks for real data after Phases 3-5`. Merge once all 5 Playwright specs pass and `/market/[id]` demonstrates a live round-trip from bet → bin delta → resolution.
