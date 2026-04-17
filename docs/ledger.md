# Ledger conventions

> The full design rationale is in `docs/adrs/ADR-0001-ledger-subsystem.md`. This
> file documents the conventions engineers need to follow when *using* the
> ledger from application code.

## Source of truth

- **Append-only log.** `public.ledger_entries` is the only authoritative record
  of money movement. It is structurally append-only: `UPDATE`, `DELETE`, and
  `TRUNCATE` all raise via triggers, for every role including `service_role`.
  New migrations that mutate `ledger_entries` are rejected by the CI
  `ledger-guard` job.
- **Cache.** `public.wallets` is a reconcilable cache of
  `SUM(amount_micro)` grouped by `(user_id, account, currency)`. On any
  disagreement, entries win: `public.reconcile_wallet_cache(user_id)` rebuilds
  the cache from entries.
- **Invariant.** Globally, `SUM(ledger_entries.amount_micro) = 0`. Locally, for
  every sampled `(user_id, account, currency)`,
  `wallets.balance_micro = SUM(ledger_entries.amount_micro)`. Both are
  checked hourly by the `check-ledger-invariants` edge function, which pages
  `$DISCORD_WEBHOOK_URL` on any drift.

## Units

All balances are stored as `bigint` **micros** (1 micro = 10⁻⁶ of the
currency's natural unit). `USDC` amount_micro of `1_000_000` = $1.00 USDC. There
is no rounding in the ledger path — fees, payouts, and refunds must be
pre-computed as integers.

## Writing money

All writes go through `public.post_transfer(txn_id uuid, legs jsonb, reason
text)`, which is `SECURITY DEFINER` and `service_role`-only. Do not write to
`ledger_entries` or `wallets` directly. The canonical entry point from TS is
`@haltmarket/ledger-client`:

```ts
import { createLedgerClient, transfers } from '@haltmarket/ledger-client';
import { randomUUID } from 'crypto';

const client = createLedgerClient(supabase); // service-role supabase-js client

await client.postTransfer({
  txnId: randomUUID(),
  legs: transfers.betPlacement({
    userId,
    marketId,
    betId,
    currency: 'USDC',
    stakeMicro: 10_000_000n, // $10.00
  }),
  reason: 'bet:place',
});
```

`post_transfer` guarantees, in one transaction:

1. **Idempotency.** Duplicate `txn_id` → `unique_violation`. Callers that want
   at-most-once semantics must persist the UUID before calling.
2. **Balance.** `SUM(amount_micro)` across legs must equal `0`, else
   `check_violation`.
3. **Leg validity.** Each leg needs a non-zero `amount_micro`, a valid
   `account` / `currency` enum, and a `user_id` iff `account = 'user_wallet'`.
4. **No overdraft.** After the transfer, every touched `user_wallet` must have
   `balance_micro >= 0`, else `check_violation` and the whole transfer rolls
   back. This is the structural stop-gap; hot-path callers should still check
   balance eagerly for fast 4xx feedback.

The `ledger-client` classifies Postgres errors into a typed `LedgerError`
(`'duplicate_txn_id' | 'unbalanced_legs' | 'invalid_leg' | 'overdraft' |
'transport'`) so edge functions can branch without string-matching.

## Canonical transfer patterns

The full catalogue (ADR-0001 appendix). Every pattern is implemented as a pure
builder in `packages/ledger-client/src/index.ts` under `transfers.*`.

| Event | Legs | Builder |
|---|---|---|
| Deposit of $X | `(+) user_wallet`, `(−) pending_deposits` | `transfers.deposit` |
| Bet placement | `(−) user_wallet`, `(+) market_pool` | `transfers.betPlacement` |
| Bet refund (market unresolved) | `(−) market_pool`, `(+) user_wallet` | `transfers.betRefund` |
| Winner payout | `(−) market_pool`, `(+) user_wallet` | `transfers.winnerPayout` |
| House fee on resolution | `(−) market_pool`, `(+) house_fees` | `transfers.houseFee` |
| Withdrawal | `(−) user_wallet`, `(+) pending_withdrawals` | `transfers.withdrawal` |

Market resolution is the one case that combines several patterns under a single
`txn_id`: one debit from `market_pool` balanced by N credits across
`house_fees` and winners. The resolver (Phase 5) constructs this N-leg array
and passes it to `post_transfer` in one call.

## Adding a new transfer pattern

1. **Add a new `reason` convention**, not a new column. Reasons are freeform
   strings (`'bet:place'`, `'deposit:stub'`, `'market:resolve'`,
   `'test:seed-deposit'`, …); grep is the index.
2. **Add a builder** in `transfers.*` that returns `TransferLeg[]` summing to
   zero.
3. **Add a unit test** for the builder in `index.test.ts` and an integration
   test in `integration.test.ts`.
4. **Never add a new `ledger_account` enum value without an ADR amendment.**
   The five values cover every money movement in the system. New money types
   (marketing credits, bonuses, promos) are tracked via `reason` + a new
   builder, not a new account.

## Reasoning about concurrency

`post_transfer` relies on Postgres row-level locks (taken by
`INSERT ... ON CONFLICT DO UPDATE`) to serialize writes against the same wallet
row. Two concurrent bets on the same user run fully serially against the
`wallets` row; the overdraft check runs *after* the upsert so a balance that
would have gone negative at commit time is caught. The concurrency test in
`integration.test.ts` validates this (20 parallel bets against a
`1_000_000`-micro balance → exactly 10 accepted, 10 rejected with
`overdraft`).

Callers that need stricter cross-wallet serialization should open the
transaction at `SERIALIZABLE` isolation before calling `post_transfer`. For
single-wallet operations (the common case), the default isolation + the
overdraft check is sufficient.

## Operator tools

- `public.ledger_global_sum()` — returns `SUM(amount_micro)` across all
  entries. Must be `0`. Used by the hourly invariant job.
- `public.ledger_wallet_drift(limit int)` — samples up to `limit` random wallet
  rows and returns any whose cached balance disagrees with the entries sum.
  Empty result = no drift detected in the sample.
- `public.reconcile_wallet_cache(user_id uuid)` — operator-only: deletes the
  user's `wallets` rows and rebuilds them from `ledger_entries`. Invoked from
  `docs/runbook-drift.md` step 5.

## Testing the ledger

- **Unit tests** (`packages/ledger-client/src/index.test.ts`, run with
  `pnpm test`): leg builders, balance assertion, error classification,
  RPC plumbing against a mock client. 10K-iteration property test that every
  randomly generated transfer sums to zero.
- **Integration tests**
  (`packages/ledger-client/src/integration.test.ts`, run with
  `./scripts/ledger-integration.sh` locally or via the `node` job in CI):
  end-to-end against a real Postgres 17. Covers each canonical pattern,
  duplicate-txn rejection, overdraft rejection, unbalanced rejection, N-leg
  resolution, 20-way parallel bet placement, intra-transaction rollback
  (failure injection), and append-only enforcement at the trigger level.
- **Invariant check**: the `check-ledger-invariants` edge function verifies
  global SUM and sampled wallet drift every hour in production.
