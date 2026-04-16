# Ledger conventions

**Phase 1 will land the full implementation** (migration `0001_ledger.sql`, `post_transfer` RPC, hourly invariant check, `packages/ledger-client`). This file is the Phase-0 stub so the link from `AGENTS.md` resolves. Contents finalized in Phase 1 per ADR-0001.

## Five canonical transfer patterns (preview, ADR-0001 appendix)

| Event | Legs |
|---|---|
| Deposit of $X | `(+) user_wallet`, `(−) pending_deposits` |
| Bet placement | `(−) user_wallet`, `(+) market_pool` |
| Bet refund | `(−) market_pool`, `(+) user_wallet` |
| Winner payout | `(−) market_pool`, `(+) user_wallet` |
| House fee | `(−) market_pool`, `(+) house_fees` |
| Withdrawal | `(−) user_wallet`, `(+) pending_withdrawals` |

Every transfer sums to zero within a single `txn_id`.
