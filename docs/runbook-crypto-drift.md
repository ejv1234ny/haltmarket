# Runbook: crypto rail drift

**Trigger:** The `reconcile-crypto` scheduled edge function posted a Discord
alert `Crypto drift detected. drift=<N> micros. Deposits auto-frozen.`

The reconciliation job compares:

```
expected = abs(ledger pending_deposits) + in-flight pending_withdrawals
on-chain = USDC balance(hot Safe) + USDC balance(cold Safe)
drift    = on-chain - expected
```

Drift > $1 (1_000_000 micros) means something moved on-chain that the ledger
doesn't know about, or the ledger recorded a credit that didn't actually hit
the Safe. Treat as `SEV-1`.

## Immediate actions

### 1. Verify the freeze

`reconcile-crypto` auto-flipped `system_flags.deposits_frozen = true` on
drift. Confirm in Supabase:

```sql
select flag, value, note, updated_at
  from public.system_flags
 where flag in ('deposits_frozen', 'withdrawals_frozen');
```

If `deposits_frozen` is not true, flip it via `/admin` freeze toggles or:

```sql
update public.system_flags
   set value = true, updated_at = now(), note = 'manual freeze during drift incident'
 where flag in ('deposits_frozen', 'withdrawals_frozen');
```

### 2. Capture snapshots

Both the ledger side and the on-chain side. On-chain snapshot is a point-in-
time block number — Alchemy's explorer for the hot + cold Safe addresses.

```bash
# Ledger side
pg_dump "$SUPABASE_DB_URL" \
  --schema=public \
  --table=public.ledger_entries \
  --table=public.deposits \
  --table=public.withdrawals \
  --table=public.crypto_orphan_deposits \
  --file="crypto-drift-$(date -u +%Y%m%dT%H%M%SZ).pgdump"

# On-chain: record block number and both balances
cast call --rpc-url https://mainnet.base.org \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "balanceOf(address)(uint256)" "$HOT_WALLET_ADDRESS"
cast call --rpc-url https://mainnet.base.org \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "balanceOf(address)(uint256)" "$COLD_WALLET_ADDRESS"
cast block-number --rpc-url https://mainnet.base.org
```

### 3. Identify the drift

Three common causes, in order of likelihood:

**(a) Orphan deposits.** A USDC send landed at the Safe from an unmapped
address. `credit_crypto_deposit` raised H0014 and `record_orphan_deposit`
captured the row. On-chain balance is ahead of ledger expected.

```sql
select count(*) as unresolved,
       sum(amount_micro)::bigint as total_unresolved_micros
  from public.crypto_orphan_deposits
 where resolved_at is null;
```

If `total_unresolved_micros` matches the drift, resolve those via
`docs/runbook-orphans.md`.

**(b) Withdrawal paid on-chain but not recorded.** Admin sent USDC via the
Safe but didn't call `mark_withdrawal_paid`. On-chain balance is behind
ledger expected.

```sql
select w.id, w.amount_micro, w.destination_address, w.created_at
  from public.withdrawals w
 where w.status = 'pending'
   and w.created_at < now() - interval '1 hour'
 order by w.created_at asc;
```

For each, grab the real tx hash from BaseScan + call:

```sql
select public.mark_withdrawal_paid('<withdrawal_id>', '0x<tx_hash>', <block_number>);
```

**(c) Deposits-watcher crash mid-credit.** The watcher inserted a `deposits`
row but the follow-up `post_transfer` failed (check constraint, network
blip). Query for confirmed deposits without a linked ledger transfer:

```sql
select d.id, d.tx_hash, d.amount_micro, d.from_address
  from public.deposits d
  left join public.ledger_transfers lt on lt.txn_id = d.txn_id
 where d.status = 'confirmed' and d.provider = 'crypto_base' and lt.txn_id is null;
```

Any rows here are broken. Delete them (no ledger side-effect; it's safe) and
re-fire the Alchemy webhook for those tx_hashes.

### 4. Unfreeze

Once expected = on-chain ± threshold:

```sql
update public.system_flags set value = false where flag = 'deposits_frozen';
update public.system_flags set value = false where flag = 'withdrawals_frozen';
```

Verify by calling the reconcile edge function manually:

```bash
curl -H "x-reconcile-key: $RECONCILE_KEY" \
  https://sqjdfafewyphoroaivqq.supabase.co/functions/v1/reconcile-crypto
```

Response `drift_micros` should be within ±$1.

### 5. Post-mortem

Same format as `runbook-drift.md` §7. File in
`docs/postmortems/YYYY-MM-DD-crypto-drift.md`. Highlight whether the cause
was an orphan (user-driven), an ops mistake (withdrawal), or a watcher bug.

## Escalation

- Cold-wallet drift > $100: founder + cold-wallet signers page.
- Hot-wallet drift > $1000 with unknown cause: freeze all rails (deposits +
  withdrawals + markets) and convene.
- Any discrepancy that a simple rescue/mark-paid can't reconcile within 24h
  goes to the external auditor track.
