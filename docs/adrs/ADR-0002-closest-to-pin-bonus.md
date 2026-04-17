# ADR-0002: Closest-to-pin bet UX and client-side bin mapping

**Status:** Accepted (applies to Phase 7 frontend)
**Date:** 2026-04-17
**Deciders:** Eric (founder), Codespace B (frontend track)
**Related:** `docs/design.md` §4.1, §6 · `AGENTS.md` Phase 3, Phase 4, Phase 7

---

## Context

The settlement mechanism chosen in `docs/design.md` §4.1 is a parimutuel pool over a
20-bin log-spaced price ladder. Bins are a *settlement* primitive: they define which
stake wins when the reopen print lands. They are not a *UX* primitive.

Surfacing the 20 bins directly — "pick bin 7 of 20, price range \$104.33–\$105.21" — is
fine for a market-maker's dev tool and wrong for everyone else. LUDP halts run 5
minutes, peak bet traffic is in the first 60–90s, and most users will be on mobile.
Users think in *prices* ("it'll reopen around \$118"), not in *bin indices*.

Two related questions:

1. **How does the user enter a bet?** Pick a bin, or type a target price?
2. **What's the win condition?** Reopen price lands in the chosen bin, or closest
   prediction across all bets wins?

If we change (2) we change the mechanism (ADR-0001 and the Phase 3 ladder math
become partly moot). If we change only (1), the ladder stays the same and the UI is
free to present a single-price input.

---

## Decision

**Keep the 20-bin parimutuel mechanism from `docs/design.md` §4.1 unchanged.**
**Change the UX to a "guess the price" input that the client auto-maps to the
nearest bin.** Winners are determined by which bin the reopen price lands in —
exactly as Phase 3 specifies — so the client-side mapping is purely presentational.

Concretely:

- The bet form takes a single numeric input: the user's *predicted reopen price*.
- As the user types, the client resolves that price to a bin using the market's
  published bin ladder (low/high per bin). The UI shows: which bin, the current
  stake in that bin, the current implied payout multiple, and how crowded the
  neighbouring bins are.
- The API call to `place-bet` sends `{ market_id, bin_id, stake_micro,
  idempotency_key }` — same payload Phase 4 will ship. The bin resolution lives
  in the client.
- Users can still see the full ladder on demand (an expandable "advanced view")
  but the primary affordance is the price input.

**"Closest to pin" is a branding phrase, not a scoring rule.** The file name
reflects the feel of the UX (you're aiming at a price, not claiming a range). The
actual scoring stays parimutuel-per-bin.

---

## Options Considered

### Option A: Bin picker (literal surfacing of the ladder)

20 segmented buttons, user taps one. Simple to implement; matches the API exactly.
Fails on mobile (20 targets is too many), forces users to learn the bin concept,
and makes it hard to express "around \$118" without hunting the ladder.

### Option B: Single price input, client-side auto-map to bin *(chosen)*

Price input with live bin feedback. Keeps mechanism unchanged, matches how users
think, small implementation cost (ladder fetched with the market payload and
binary-searched on keystroke).

### Option C: Continuous-pricing mechanism (true closest-to-pin)

Replace bins entirely with a distance-weighted payout. Interesting but changes
ADR-0001 semantics (no discrete `winning_bin_id`), requires rethinking the
resolver and the ledger transfer pattern, and invalidates Phase 3/4 work in
flight. Deferred.

---

## Consequences

### Easier
- **Mental model.** Users bet "the reopen price." That's the whole UI.
- **Mobile-first.** One numeric input + stake slider is trivially thumbable.
- **Zero backend churn.** Phase 4 `place-bet` and Phase 3 bin schema unchanged;
  the client just computes `bin_id` from price before submitting.

### Harder
- **Bin boundaries visible under scrutiny.** Typing \$104.32 vs \$104.34 can land
  in different bins when they straddle a boundary. The UI must show the resolved
  bin so this isn't a surprise at settlement.
- **Ladder must reach the client.** `GET /markets/:id` already returns bins
  (design §6) so this is free, but any API that omitted bins would break the UX.
- **Branding risk.** Users hearing "closest to pin" may expect a continuous
  scoring rule. Copy on the market page must be explicit: "win the pool if the
  reopen lands in your bin."

### Revisit
- If post-launch data shows users consistently losing by one bin (boundary
  frustration), consider Option C — a true continuous mechanism — as a Phase 11+
  project with its own ADR and ledger/resolver rework.

---

## Implementation notes (Phase 7)

- Bin resolution helper lives in `apps/web/lib/bins.ts` — pure function
  `resolveBin(price, bins) → Bin | null`, binary search on `low_price`.
- The primary bet component is `apps/web/components/bet-form.tsx`; it never
  renders bin indices as primary affordances, only as secondary confirmation.
- Mock ladder used in Phase 7 matches the Phase 3 spec (20 log-spaced bins,
  `0.5×last_price` to `2.0×last_price`) so swapping mocks for the real payload
  in the post-critical-path follow-up PR is a pure data swap.
