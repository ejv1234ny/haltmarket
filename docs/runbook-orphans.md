# Runbook: orphan deposit rescue

**Trigger:** `/admin` shows pending rows in the **Orphan deposits** section,
or deposit-watcher logs report H0014 (`crypto_unknown_sender`) for a
tx_hash you expected to land.

An orphan is a USDC send to the Safe hot wallet from an address we haven't
mapped to a user yet. Common causes:

- User withdrew from an exchange (Coinbase, Binance) which uses an exchange-
  owned hot wallet the user hasn't mapped.
- User used a wallet other than their Privy embedded one.
- Test transfer from a dev wallet.

Orphans do **not** break the ledger invariant — the watcher records them in
`public.crypto_orphan_deposits` and leaves the USDC sitting in the Safe.
The `reconcile-crypto` job will flag the drift and auto-freeze deposits if
orphans pile up (`docs/runbook-crypto-drift.md`), so resolve promptly.

## Standard rescue (happy path)

1. Contact the depositing user, typically via their email on file. Confirm
   they intended the deposit and get the sending address from them.
2. Verify the address on BaseScan matches what they claim.
3. Navigate to `/admin` → **Orphan deposits** section → click **Bind +
   credit** on the row.
4. Paste the target user's `user_id` (UUID). You can fetch it from
   `/admin/users` by searching their email.
5. Confirm. The admin action:
   - Inserts the sender address into `user_wallet_addresses` (source=`ops`)
   - Calls `credit_crypto_deposit` with the stored orphan fields
   - Marks the orphan resolved
6. Verify the user's `/wallet` balance went up and `ledger_global_sum()` is
   still 0.

## Ignore (sender unknown or unwanted)

Some orphans will never be claimed. Policy per AGENTS.md §5: `Ignore` the
row if **any** of these apply:

- The user cannot be identified after 30 days of outreach.
- The sender is a known dust/spam source.
- The amount is < $1 (dust; not worth ops time).
- You suspect the send was a mistake (wrong chain, wrong token).

Click **Ignore** on the row, supply a reason (min 3 chars). The row is
closed (`resolved_at` set) without a user credit. The USDC stays in the
Safe hot wallet; ops can later move it to cold storage or refund the
sender manually via the Safe web app. **That refund is an out-of-band
action**; there is no automated refund path for unclaimed orphans in
alpha.

## Batch rescue

If the watcher has a backlog (network blip or misconfigured Alchemy filter),
you can rescue many orphans at once:

```sql
-- List of orphans for a single known user's address
select id, tx_hash, from_address, amount_micro, detected_at
  from public.crypto_orphan_deposits
 where resolved_at is null
   and lower(from_address) = lower('0x<user_address>');

-- Rescue each one
select public.admin_rescue_orphan_deposit(id, '<user_uuid>'::uuid)
  from public.crypto_orphan_deposits
 where resolved_at is null
   and lower(from_address) = lower('0x<user_address>');
```

Run as an admin-authenticated session (psql set role / local claim, or via
the Supabase SQL editor where you're already admin).

## If the orphan table is full of garbage

Someone might spam the Safe with zero-value or token-dust transfers. You
can ignore in bulk:

```sql
select public.admin_ignore_orphan_deposit(id, 'dust: amount < $1')
  from public.crypto_orphan_deposits
 where resolved_at is null and amount_micro < 1_000_000;
```

If spam rate is high, consider tightening the Alchemy Notify filter to
reject below a minimum USDC value.

## Post-rescue verification

Always re-run reconciliation after a rescue pass:

```bash
curl -H "x-reconcile-key: $RECONCILE_KEY" \
  https://sqjdfafewyphoroaivqq.supabase.co/functions/v1/reconcile-crypto
```

Expected: `drift_micros` near zero, `breach: false`. If drift persists,
follow `docs/runbook-crypto-drift.md`.
