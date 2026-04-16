# ADR-0001: Ledger Subsystem

**Status:** Proposed
**Date:** 2026-04-16
**Deciders:** Eric (founder), future engineering lead, future compliance lead
**Related:** `docs/design.md` §4.2 and §5

---

## Context

haltmarket moves real money between users, a shared market pool, and a house-fee account. Every bet, payout, fee, deposit, withdrawal, and refund is a money movement that must be correct to the sub-cent, auditable forever, and impossible to lose or duplicate.

Forces at play:

- **Correctness is non-negotiable.** One integer-overflow bug or misplaced rollback and the platform owes money it doesn't have, or refuses money it does.
- **Parimutuel math is multi-party.** Resolving a single market = 1 pool debit + 1 fee credit + N winner credits, atomic. The ledger must support multi-leg transactions cleanly.
- **Real-money regulation.** Operating offshore with USDC still requires auditable records for AML and future CFTC registration.
- **Speed.** Bet placement p95 < 500ms end-to-end; ledger write path < 50ms.
- **Team size = 1-2 engineers.** Cannot afford a new database unless dramatically better than alternatives.
- **Existing stack.** Supabase Postgres. Adding a second datastore is a significant operational cost.
- **Volume.** Phase 2: ~10K entries/day. Phase 4: ~1M entries/day. Small by ledger-DB standards.
- **Regulator-grade audit.** Entries immutable post-write. Corrections via reversing entries, never mutating history.

Decision covers: (1) how balances are represented, (2) where the ledger physically lives, (3) how multi-leg transactions are atomic, (4) how drift is detected and prevented.

---

## Decision

**Build a double-entry, append-only ledger in Supabase Postgres with integer-micros precision, multi-leg atomic writes via `SERIALIZABLE` transactions, and hourly invariant checks.** Wallet balances are a reconcilable cache, not a mutable source of truth.

Every money movement produces two or more rows in `ledger_entries` that sum to zero within a `txn_id`. All writes flow through SECURITY DEFINER RPCs; application code cannot bypass. Balances read from a `wallets` cache row updated inside the same transaction as the entries. Cache disagreement → entries win.

---

## Options Considered

### Option A: Denormalized balance + transaction log

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Low |
| Scalability | Fine at our volume |
| Team familiarity | High |
| Correctness ceiling | **Low — silent drift possible** |

**Pros:** Ships fastest. Standard CRUD. Single-row balance lookup.

**Cons:** Balance column authoritative but divorced from log. Bug that updates one without the other = silent drift. No structural enforcement of debits == credits. Every fintech that starts this way eventually replaces it.

---

### Option B: Double-entry in Postgres with derived balances *(chosen)*

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Low |
| Scalability | Good to ~1M entries/day |
| Team familiarity | Medium |
| Correctness ceiling | **High — invariants structurally enforceable** |

**Pros:** Industry standard (Stripe, Square, neobanks use variants). Multi-party transactions natural. `SUM(amount_micro) = 0` globally is one-query invariant. Append-only = built-in audit log. Cache rebuildable from entries.

**Cons:** Higher mental overhead — "why two rows for one bet?" needs explanation. `SERIALIZABLE` costs ~10-20% throughput. Discipline required: all writes through RPC; direct `UPDATE wallets SET balance` breaks invariants. RLS must be tight.

---

### Option C: Dedicated ledger service (TigerBeetle)

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | Medium |
| Scalability | Millions of TPS |
| Team familiarity | Low |
| Correctness ceiling | **Highest — it's the whole product** |

**Pros:** Purpose-built for this. Transfers atomic by design. Deterministic replication = point-in-time audit replay free. Small opinionated API eliminates bug classes. Eventual destination if big.

**Cons:** Separate datastore to operate, back up, monitor. No SQL; reporting is app-side. Data split across two systems from day one. Overkill at Phase 0-1. Learning curve real; no time on a 1-2 person team.

**Revisit when:** >500K entries/day, or a second regulator requires verifiable records, or we hire platform engineer. Migration B→C is mechanical (same primitives).

---

### Option D: On-chain ledger (USDC smart contract)

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | Medium (gas/bet) |
| Scalability | Fine on L2 |
| Team familiarity | Low |
| Correctness ceiling | High — iff the contract is audit-clean |

**Pros:** Architecturally pure for crypto-native. Non-custodial (contract custodies). Radical transparency. Easier regulatory story in some jurisdictions.

**Cons:** Gas per bet — Polygon $0.01, mainnet $0.50+. $0.50 kills UX for $5 bets. Meta-tx relayer = more infra. Contract bugs catastrophic + final. Audit (Trail of Bits / OpenZeppelin) is $30-100K and 6-12 weeks. Block time vs 90s window is tight.

**Revisit when:** Phase 4+ with crypto-native PMF and a dedicated smart-contract engineer.

---

## Trade-off Analysis

Real choice is A vs B. C and D are correct long-term destinations but wrong short-term choices.

**A vs B.** Classic "simple now, pain later" vs "structural correctness now, slight ceremony." For money, B wins cleanly:

1. Upside of A is a few days of engineering saved.
2. Downside of A is silent balance drift in production, discovered via user complaint, unrecoverable without forensic audit. Weeks of engineering plus reputational damage.

Cost of B is bounded, pays rent daily. Cost of A is unbounded and compounds.

**B vs C.** At Phase 1-2 volumes, Postgres handles 10-100× what we need. TigerBeetle's correctness gain doesn't justify second-datastore ops cost for 1-2 person team. B designed to migrate cleanly to C (identical primitives).

**B vs D.** Crypto-native vs not. USDC is our launch currency; most users want "deposit and forget." On-chain custody is a product feature, not an architecture decision. Gas per bet is unforced UX penalty at Phase 0.

---

## Consequences

### Easier
- **Auditability.** Every penny's journey = SQL query by `txn_id`.
- **Multi-leg transactions.** Market resolution (debit + fee + N credits) = one transaction.
- **Reconciliation.** Wrong cache row → regenerate with `SUM(amount_micro) WHERE user_id = X`.
- **Future migration to TigerBeetle.** Same conceptual schema.
- **Fraud investigation.** Any filter on entries is always one query.

### Harder
- **Onboarding.** 15-min "double-entry 101" for every new engineer + code-review discipline.
- **Manual prod fixes banned.** All corrections via reversing entries.
- **Hot-path latency budget.** SERIALIZABLE + two-row write + cache update ~10-30ms. Must stay inside 500ms p95.
- **Reporting queries.** Current balance = cache (fast); aggregated reports = scan + indexes + possibly materialized views.

### Revisit
- **Sharding `ledger_entries`** at ~100M rows (~1 year at Phase-4). Partition by month.
- **TigerBeetle migration** at ~500K entries/day or regulator demand.
- **Multi-currency.** FX (USD↔USDC) needs a dedicated FX account + coupled transactions.
- **Escheatment.** Dormant-account policy — legal input needed.

---

## Action Items

1. [ ] Write `ledger_entries`, `wallets`, `deposits`, `withdrawals` migration with constraints:
   - `CHECK (amount_micro != 0)` on entries
   - `CHECK (currency IN ('USDC'))` to start
   - Index on `(user_id, currency, created_at desc)`
   - Index on `txn_id`
   - No `UPDATE`/`DELETE` RLS policies on `ledger_entries` — append-only structurally
2. [ ] Write `post_transfer(txn_id uuid, legs jsonb, reason text)` SECURITY DEFINER function:
   - SERIALIZABLE transaction
   - Assert `SUM(amount_micro) = 0` before commit
   - Update wallet cache atomically
   - Reject legs with `amount_micro = 0` or missing fields
3. [ ] Invariant-check job (hourly):
   - Global `SUM(amount_micro) = 0`
   - Sample 1000 users, verify cache = entries
   - Page on any discrepancy (Discord webhook)
4. [ ] Reconcile-wallet-cache RPC (operator-only) for when invariant fails.
5. [ ] Tests (critical — do not ship without):
   - Unit: each transfer type (bet, payout, fee, deposit, withdrawal, refund) has golden before/after
   - Property: 10K random sequences, `SUM = 0` holds throughout
   - Concurrency: parallel bets on same user, no double-spend
   - Failure injection: crash mid-transaction, no partial writes
6. [ ] Runbook `docs/runbook-drift.md` for the invariant-check page.
7. [ ] CI check: fail if any new migration `UPDATE`s or `DELETE`s `ledger_entries`.
8. [ ] `docs/ledger.md` documenting the double-entry convention + 5 canonical patterns.

---

## Appendix: Canonical Transfer Patterns

| Event | Legs |
|---|---|
| Deposit of $100 USDC | (+) user_wallet, (−) pending_deposits |
| Bet placement of $10 | (−) user_wallet, (+) market_pool |
| Bet refund (market unresolved) | (−) market_pool, (+) user_wallet |
| Winner payout of $50 | (−) market_pool, (+) user_wallet |
| House fee of $5 on resolution | (−) market_pool, (+) house_fees |
| Withdrawal of $100 | (−) user_wallet, (+) pending_withdrawals |

Every row is two legs summing to zero. Market resolution combines several under one `txn_id`.
