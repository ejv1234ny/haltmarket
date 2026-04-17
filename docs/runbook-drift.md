# Runbook: ledger invariant drift

**Trigger:** The `check-ledger-invariants` scheduled edge function posted a
Discord alert to `$DISCORD_WEBHOOK_URL`. One of two things failed:

- **Global invariant** — `public.ledger_global_sum()` returned non-zero. Every
  transfer is supposed to sum to zero, so the global sum is `0` by
  construction. A non-zero value means an entry was inserted outside
  `post_transfer` or a bug in `post_transfer` failed to roll back a partial
  write.
- **Cache drift** — `public.ledger_wallet_drift(1000)` returned rows. One or
  more sampled `wallets.balance_micro` disagrees with
  `SUM(ledger_entries.amount_micro)` for the same `(user_id, account,
  currency)`.

Both failures are load-bearing: the ledger is the authoritative record of user
balances. Treat as `SEV-1`.

## Immediate actions

### 1. Freeze money movement

Before investigating, stop all writes that touch the ledger. In production:

```bash
# Replace with the place-bet kill switch when it lands in Phase 4.
# For now, disable the scheduled edge functions that would fire transfers.
supabase functions schedule pause check-ledger-invariants   # optional, so we stop paging
supabase functions deploy place-bet --disabled              # Phase 4 — placeholder
```

During Phase 1 (pre-Phase 4), no production traffic moves money yet. This step
is a placeholder so the runbook is accurate at every phase.

### 2. Snapshot

Capture both tables at the alert timestamp for forensic replay. Do not rely on
PITR alone — we want a snapshot at the exact moment of the alert.

```bash
pg_dump "$SUPABASE_DB_URL" \
  --schema=public \
  --table=public.ledger_entries \
  --table=public.ledger_transfers \
  --table=public.wallets \
  --format=custom \
  --file="drift-$(date -u +%Y%m%dT%H%M%SZ).pgdump"
```

Upload the snapshot to the operator's secure storage and note the filename in
the incident channel.

### 3. Identify the offending `txn_id`

The hourly job's Discord payload includes the first five drift rows. Pull the
user_ids, then find the transfers that touched them. For a global-sum failure,
run:

```sql
-- Most recent transfers that net non-zero (should be none).
select t.txn_id, t.reason, t.created_at, sum(e.amount_micro) as net
from public.ledger_transfers t
join public.ledger_entries e on e.txn_id = t.txn_id
group by t.txn_id, t.reason, t.created_at
having sum(e.amount_micro) <> 0
order by t.created_at desc
limit 50;
```

For a cache-drift failure, compare entries vs cache for the offending user:

```sql
select account, currency,
       (select balance_micro from public.wallets w
          where w.user_id = $1 and w.account = e.account and w.currency = e.currency) as cache,
       sum(amount_micro) as entries_sum
from public.ledger_entries e
where user_id = $1
group by account, currency;
```

### 4. Reverse, do not mutate

Corrections MUST be reversing entries posted via `post_transfer`, never
`UPDATE`/`DELETE` on `ledger_entries`. Append-only is enforced by trigger (and
CI), so any "quick fix" via direct mutation is blocked by design.

Example — reverse a bet that was double-booked:

```sql
select public.post_transfer(
  gen_random_uuid(),
  jsonb_build_array(
    jsonb_build_object('user_id', $user_id, 'account', 'user_wallet',
                       'currency', 'USDC', 'amount_micro', 10000000,
                       'ref_market_id', $market_id),
    jsonb_build_object('account', 'market_pool', 'currency', 'USDC',
                       'amount_micro', -10000000, 'ref_market_id', $market_id)
  ),
  'correction:reverse-double-bet:' || $original_txn_id::text
);
```

The `reason` prefix `correction:…` is the convention for reversing entries so
they're greppable during audit.

### 5. Rebuild the wallet cache

Once entries are consistent, rebuild any affected user's cache from entries:

```sql
select public.reconcile_wallet_cache('<affected-user-uuid>'::uuid);
```

If many users were affected, batch:

```sql
do $$
declare u uuid;
begin
  for u in select distinct user_id from public.ledger_entries where user_id is not null
  loop
    perform public.reconcile_wallet_cache(u);
  end loop;
end $$;
```

### 6. Verify

Re-run the invariants manually before unfreezing:

```sql
select public.ledger_global_sum();           -- must be 0
select * from public.ledger_wallet_drift(10000);  -- must be empty
```

Then unfreeze money movement and unpause the scheduled function.

### 7. Post-mortem

Write up within 48h: timeline, offending `txn_id` / reason, root cause
(`post_transfer` bug vs a direct write that bypassed it vs migration regression
vs …), fix, and whatever structural change prevents recurrence. File in
`docs/postmortems/YYYY-MM-DD-ledger-drift.md` and link from `docs/progress.md`.

## Escalation

1. Post in `#haltmarket-oncall` with the snapshot filename and the first
   offending `txn_id`.
2. Page the founder (@eric) if the offending txns involve customer funds that
   the ledger alone cannot reconstruct.
3. External auditor for any drift exceeding $1000 in aggregate or older than
   24h before detection — the blast radius is beyond a single
   `reconcile_wallet_cache` call.

## Known false positives

None yet. Any drift reported by the hourly job is real until proven otherwise.
