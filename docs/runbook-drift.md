# Runbook: ledger invariant drift

**Trigger:** Hourly invariant-check edge function posts a Discord alert because either (a) global `SUM(ledger_entries.amount_micro) != 0` or (b) a sampled user's `wallets.balance_micro` disagrees with their `ledger_entries` sum.

Full runbook lands with Phase 1 (the invariant job itself ships in Phase 1). This Phase-0 stub exists so the link from `AGENTS.md` resolves and operators have a single canonical on-call location.

## Immediate actions (to be fleshed out in Phase 1)

1. **Freeze bet placement.** The `place-bet` edge function must short-circuit on a kill-switch config row.
2. **Snapshot.** Capture `wallets`, `ledger_entries` at the alert timestamp for forensic replay.
3. **Identify the `txn_id` that broke the invariant** — the hourly job logs the offending group.
4. **Reverse, do not mutate.** Corrections are reversing entries, never `UPDATE`/`DELETE` on `ledger_entries` (ADR-0001, CI gate enforced).
5. **Rebuild the wallet cache** from `ledger_entries` using the operator-only `reconcile_wallet_cache(user_id)` RPC (Phase 1).

## Escalation

`#haltmarket-oncall` (Discord) → @founder → external auditor if funds are unrecoverable from entries alone.
