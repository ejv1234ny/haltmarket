# ADR-0002: Hybrid Parimutuel With Closest-to-the-Pin Bonus

**Status:** Proposed
**Date:** 2026-04-17
**Deciders:** Eric (founder)
**Related:** `docs/design.md` §4.1, `docs/adrs/ADR-0001-ledger-subsystem.md`

---

## Context

The original design (design.md §4.1 + AGENTS.md §Phase 3-5) specifies a **parimutuel pool over a 20-bin log-spaced price ladder**. The bin containing the official reopen price wins; all bettors in that bin split `total_pool × (1 − fee)` pro-rata by stake.

The founder's stated product vision, captured separately, uses different UX framing: *"users guess the reopen price, closest wins."* That phrasing, taken literally, describes a **closest-to-the-pin** mechanic — a single-winner, highest-drama format.

These are not the same system. This ADR records which mechanic haltmarket launches with and how the two framings reconcile.

Forces at play:

- **Retention.** Pure closest-to-the-pin produces one winner per halt. At 30–40 halts/day and one winner each, a typical user wins ~1 in 20 sessions. Every at-scale prediction/betting product rejects this for that reason (Kalshi → order-matched, Polymarket → order-matched, sports books → fixed-odds with many winners, horse racing → parimutuel).
- **UX clarity.** "Guess the price" is a three-word onboarding line. "Pick a price bin" is confusing to a first-time user and requires explaining the ladder.
- **Drama / social.** Single-winner outcomes drive sharing. *"Eric called it at $4.27 and won the whole pot"* is a shareable moment. A parimutuel bin win split 15 ways isn't.
- **Liquidity at launch.** We expect thin books — most halts will have $100–$2,000 total pool in the first 90 days. A mechanic that makes thin pools feel rewarding to winners is essential.
- **Skill vs luck.** Parimutuel bins mostly reward being in the right zone. Closest-to-the-pin rewards precision — a real edge for informed traders, but a barrier for new users.

The decision covers: (1) which mechanic ships at v1, (2) how the founder's "guess the price, closest wins" UX is preserved, (3) how the math works at resolution, (4) edge cases.

---

## Decision

**Ship the parimutuel 20-bin ladder as the primary mechanic. Layer a closest-to-the-pin bonus pool on top. Reframe the user-facing UX as "guess the price" — the bin is an implementation detail the user never directly sees.**

Concretely:

1. **User enters a numeric predicted price** (e.g., `$4.25`) in the bet-placement UI.
2. The client **auto-maps the predicted price to the nearest bin** on the 20-bin log-spaced ladder and records both `predicted_price` and `bin_id` on the bet.
3. The user sees their bet summary as *"Your guess: $4.25 · Stake: $10"* — no bin selection, no ladder exposed by default. A "show ladder" disclosure toggle reveals the bin map for power users.
4. **Pool is partitioned at resolution into three buckets:**
   - **House fee** — configurable, default 5% of gross pool
   - **Closest-to-the-pin bonus** — configurable, default 7% of gross pool, awarded to the single user whose `predicted_price` is nearest the actual reopen price
   - **Main payout pool** — the remainder (default 88% of gross pool), distributed pro-rata across all bettors in the winning bin by stake
5. A single user can win both the main payout (if their bin contains the reopen) and the closest bonus (if their typed price was nearest). These are separate, additive payouts.

The ledger schema from ADR-0001 already supports this — the bonus is one additional leg at resolution time, no schema change.

---

## Options Considered

### Option A: Pure parimutuel bin (original spec)

20 bins, winning bin splits pool pro-rata.

| Dimension | Assessment |
|---|---|
| Retention | Good — many winners per halt |
| UX clarity | Requires explaining bins |
| Social drama | Low — split wins aren't shareable |
| Skill reward | Weak — being "close enough" is enough |
| Build scope | Already spec'd and partially built |

**Pros:** Liquidity-friendly, proven mechanic (horse racing), already in the spec.
**Cons:** Doesn't match founder's verbal UX vision; no dramatic single-winner moment.

---

### Option B: Pure closest-to-the-pin

Users type a price; single user nearest the reopen takes pool minus fee.

| Dimension | Assessment |
|---|---|
| Retention | Poor — 95%+ of users lose every round |
| UX clarity | Excellent — one sentence explains it |
| Social drama | High — single dramatic winner |
| Skill reward | Very high — barrier for new users |
| Build scope | Simpler math, different Phase 5 logic |

**Pros:** Matches the verbal pitch exactly; one-line explanation; social moments.
**Cons:** No prediction market at scale uses this for repeat-play products. Retention data from Prophet, Manifold, and early Kalshi suggests 4–6 week cohort half-life vs 12+ weeks for multi-winner mechanics. Thin pools feel worse because the single prize is small relative to stake when total pool is $300.

**Rejected** on retention grounds. The math is unambiguous: a user playing 20 halts at 2-5% win rate churns before they form a habit.

---

### Option C: Hybrid parimutuel + closest-to-the-pin bonus *(chosen)*

Parimutuel bin mechanic with a small bonus pool carved out for the single closest user.

| Dimension | Assessment |
|---|---|
| Retention | Good — bin winners still share pool |
| UX clarity | Excellent with auto-mapping (user never sees bins) |
| Social drama | Good — bonus creates a single-winner moment per halt |
| Skill reward | Moderate — precision earns the bonus, coarse-good-enough earns bin share |
| Build scope | +1 leg in resolution math, +1 UI detail on wallet/receipt |

**Pros:** Preserves retention-critical multi-winner dynamics. Recovers the founder's "closest wins" social moment via the bonus. Reframes UX as "guess the price" via client-side auto-mapping. No schema change.
**Cons:** Slightly more complex payout explanation on receipts ("you won $15 for the zone + $8 closest-to-the-pin bonus"). Requires tuning the bonus percentage (too low = no drama, too high = bin winners feel cheated).

---

### Option D: Skill leaderboard with smaller cash prizes

Everyone gets back their stake on a correct bin; a separate weekly leaderboard pays cash prizes for top accuracy.

| Dimension | Assessment |
|---|---|
| Retention | Very high |
| UX clarity | Complex — two parallel games |
| Social drama | Spread out over weeks |
| Regulatory | Starts to look like a skill game, not gambling |
| Build scope | Large — separate scoring + settlement system |

**Pros:** Most retention-positive. Strongest skill-game framing for regulatory hedging.
**Cons:** Significant new subsystem. Defers the dopamine loop from 5 min (halt resolves) to weekly (leaderboard pays). Wrong time-horizon for the product.

**Rejected** as the launch mechanic but worth revisiting as a v2 overlay.

---

## Trade-off Analysis

The core choice is A vs C. B and D are bracketing alternatives that clarify why C is the right middle.

**A vs C.** Option A ships slightly faster (no bonus math, no price-input widget auto-map) but doesn't match the founder's verbal vision. Option C adds ~1 day of engineering (the bonus-pool leg calculation + a predicted-price numeric input in the frontend) and materially improves the product story. The cost is low relative to the product benefit.

**The bonus percentage matters.** Proposed: **7%** of gross pool. Rationale:

- At 5% or below, the bonus is small enough that bin winners don't notice it's gone but also small enough that the "closest" winner doesn't feel rewarded
- At 10% or above, bin winners start to feel like they're being taxed twice (once by the house fee, once by the bonus)
- 7% puts a $100 pool at $7 bonus + $88 main pool + $5 fee — the closest winner gets a meaningful pat on the back ($7 is 70% of their likely $10 stake), the bin winners still get the bulk

This is tunable per-market (`markets.closest_bonus_bps` column, default 700 = 7%).

**Tie-breaking on closest.** If two users tie on `|predicted - actual|` to the exact micro-dollar, the bonus is split equally. Edge case; in practice won't happen often given 4-decimal-place predictions.

**Interaction with the bin mechanic.** A user can win both the bin payout and the closest bonus. They're computed independently from the same `bets` row. Ledger-wise, that's two credits to the same `user_wallet` within the same resolution `txn_id`.

---

## Consequences

### What becomes easier

- **Onboarding copy.** "Guess the price, closest wins" is now accurate UX framing even though the math under the hood is parimutuel.
- **Social sharing.** Each halt has a single dramatic winner for the bonus — shareable on X / Discord.
- **Marketing.** A "closest bonus" leaderboard can be surfaced weekly showing top precision predictors.
- **Thin-pool UX.** On a $200 pool, one user gets a $14 bonus — visible, satisfying, even when main-pool shares are $3–$8.

### What becomes harder

- **Resolution math.** Payout calculation is now 3-part: fee + bonus + pro-rata split. One more leg in the ledger transfer at resolution. Tested path grows from "N winners + 1 fee" to "N bin winners + 1 closest winner + 1 fee" per market.
- **Receipts / UX explaining a win.** "You won $18.50 = $12 for correct zone + $6.50 closest-to-the-pin bonus" is a two-line receipt instead of one. Worth it.
- **Tuning the bonus percentage.** Needs observation in beta. May vary by market size or halt heat.

### What we'll need to revisit

- **Bonus percentage** — empirically in beta. Start at 7%; tune up if closest winners don't feel rewarded, tune down if bin winners complain.
- **Tie-breaking policy** — if ties become common (unlikely with 4-decimal predictions), may need "earliest submission wins" instead of split.
- **Skill-leaderboard overlay** (Option D) — consider adding as v2 on top of the hybrid mechanic once liquidity is established.
- **Market-size-proportional bonus** — may want the bonus to be larger (10%+) on small pools and smaller (3-5%) on huge pools, to keep drama consistent.

---

## Action Items

1. [ ] Amend `docs/design.md` §4.1 to document the hybrid mechanic and bonus math
2. [ ] Amend `AGENTS.md` §Ground Truth to reference ADR-0002 and the hybrid mechanic
3. [ ] Amend `AGENTS.md` §Phase 3 (market lifecycle) to include `closest_bonus_bps` field on markets
4. [ ] Amend `AGENTS.md` §Phase 4 (bet placement) to accept `predicted_price numeric(12,4)` on bet submission, map client-side to nearest bin, store both on the `bets` row
5. [ ] Amend `AGENTS.md` §Phase 5 (resolution) to split pool three ways (fee / closest bonus / main payout pool) and identify the single closest-by-`abs(predicted - actual)` user
6. [ ] Amend `AGENTS.md` §Phase 7 (frontend) to render a numeric price input with inline bin preview ("Your guess: $4.25 · bin $4.20–$4.30") as the primary bet UX
7. [ ] Schema addition in Phase 3 migration: `bets.predicted_price numeric(12,4)`, `markets.closest_bonus_bps int not null default 700`, `market_resolutions.closest_bonus_winner_user_id uuid`, `market_resolutions.closest_bonus_amount_micro bigint`
8. [ ] Test additions in Phase 5: tie-breaking, no-winner-in-bin-but-closest-bonus-awarded, both-wins-go-to-same-user

---

## Appendix: Resolution math worked example

Market: halt on ticker X, last_price = $4.00, 20 bins from $2.00 to $8.00 (log-spaced).
Gross pool at close: **$200.00** (200,000,000 micros USDC).
Config: `fee_bps = 500` (5%), `closest_bonus_bps = 700` (7%).

At reopen, actual price = **$4.27**.

Bettors in the winning bin ($4.20–$4.30):
- Alice — staked $30, predicted $4.25
- Bob — staked $20, predicted $4.28
- Carol — staked $10, predicted $4.22
- Winning bin total stake: $60

Bettors outside the winning bin: combined $140 of stakes from many users.

The single user with smallest `|predicted_price - actual|`:
- Alice: |4.25 - 4.27| = $0.02
- Bob: |4.28 - 4.27| = $0.01 ← closest
- Carol: |4.22 - 4.27| = $0.05
- Other bettors outside the bin could theoretically be closer — let's say the nearest outside-bin bet is Dave at $4.31 (|0.04|). Bob still wins.

Resolution payout:

| Bucket | Amount | Who receives |
|---|---|---|
| House fee | $200 × 5% = **$10.00** | `house_fees` account |
| Closest-to-the-pin bonus | $200 × 7% = **$14.00** | Bob (single closest user) |
| Main payout pool | $200 × 88% = **$176.00** | Winning-bin bettors pro-rata |
| → Alice | $176 × (30/60) = $88.00 | Alice's `user_wallet` |
| → Bob | $176 × (20/60) = $58.67 | Bob's `user_wallet` |
| → Carol | $176 × (10/60) = $29.33 | Carol's `user_wallet` |

Total credits: $10 + $14 + $88 + $58.67 + $29.33 = $200.00. Pool zero-sum preserved.

**Bob's total take:** $58.67 (bin share) + $14.00 (bonus) = **$72.67** on a $20 stake.

Ledger transfer at resolution (one `txn_id`, 6 legs summing to zero):

1. `(−) market_pool $200.00`
2. `(+) house_fees $10.00`
3. `(+) user_wallet (Bob, bonus) $14.00`
4. `(+) user_wallet (Alice, bin) $88.00`
5. `(+) user_wallet (Bob, bin) $58.67`
6. `(+) user_wallet (Carol, bin) $29.33`

Single atomic `post_transfer(txn_id, legs, 'market:resolve')`.

---

**End of ADR-0002.**
