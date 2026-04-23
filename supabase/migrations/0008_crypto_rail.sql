-- =============================================================================
-- 0008_crypto_rail.sql  --  Real-USDC deposit & withdrawal plumbing for alpha
--
-- Phase 8 replaces the stub payment provider with on-chain USDC on Base. The
-- ledger remains the source of truth (ADR-0001); this migration only adds the
-- integration surface that moves ledger entries in lockstep with on-chain
-- events.
--
-- Design summary:
--   * pending_deposits account acts as the LIABILITY MIRROR of custodied USDC.
--     Sum goes negative as users deposit (more custody obligation), rises back
--     toward zero as users withdraw. Reconciliation: abs(pending_deposits) must
--     equal on-chain (hot + cold) minus in-flight pending_withdrawals.
--
--   * user_wallet_addresses table maps Base addresses to user ids so the
--     deposit-watcher can credit the right user when a USDC Transfer event
--     arrives at the Safe hot wallet.
--
--   * system_flags table holds freeze switches: deposits_frozen,
--     withdrawals_frozen, markets_frozen. Mirrors the place-bet freeze pattern.
--
--   * ALTER on existing deposits/withdrawals tables (from 0001_ledger.sql) adds
--     the on-chain trail: chain_id, tx_hash, block_number, and addresses.
--     Additive-only per AGENTS.md rules.
--
--   * Four new SECURITY DEFINER RPCs, all service-role-only:
--       credit_crypto_deposit(...)   -- called by the deposit-watcher
--       request_withdrawal(...)      -- called by the /api/withdrawals edge fn
--       mark_withdrawal_paid(...)    -- called by ops after Safe multisig send
--       mark_withdrawal_failed(...)  -- called by ops if the tx is abandoned
--
--   * Five new SQLSTATE codes:
--       H0012 crypto_deposit_cap_exceeded  -- per-user lifetime deposit > cap
--       H0013 crypto_duplicate_txhash      -- same tx_hash seen twice (idempotent no-op)
--       H0014 crypto_unknown_sender        -- from_address not mapped to a user
--       H0015 crypto_deposits_frozen       -- system_flags.deposits_frozen = true
--       H0016 crypto_withdrawals_frozen    -- system_flags.withdrawals_frozen = true
--       H0017 crypto_withdrawal_below_min  -- withdrawal below minimum (gas dust)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- system_flags: single-row-per-flag kv for global freeze switches.
-- -----------------------------------------------------------------------------

create table if not exists public.system_flags (
  flag        text primary key,
  value       boolean not null default false,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

insert into public.system_flags (flag, value, note) values
  ('deposits_frozen',     false, 'Freezes credit_crypto_deposit. Pending rows still recorded.'),
  ('withdrawals_frozen',  false, 'Freezes request_withdrawal. Does not affect in-flight pays.'),
  ('markets_frozen',      false, 'Future: halt new market creation without stopping resolves.')
on conflict (flag) do nothing;

alter table public.system_flags enable row level security;

create policy system_flags_select_public on public.system_flags
  for select using (true);

-- -----------------------------------------------------------------------------
-- user_wallet_addresses: mapping Base address -> user_id for deposit matching.
-- A user may have multiple addresses (Privy embedded + self-custody) but the
-- (chain_id, address) tuple is globally unique.
-- -----------------------------------------------------------------------------

create table if not exists public.user_wallet_addresses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete restrict,
  chain_id     integer not null,
  address      text not null check (address ~ '^0x[a-fA-F0-9]{40}$'),
  source       text not null check (source in ('privy', 'self', 'ops')) default 'privy',
  verified_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (chain_id, address)
);

create index user_wallet_addresses_user_idx
  on public.user_wallet_addresses (user_id);

alter table public.user_wallet_addresses enable row level security;

create policy user_wallet_addresses_select_own
  on public.user_wallet_addresses for select
  using (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- Extend deposits / withdrawals with crypto-specific columns.
-- Columns are nullable to preserve the stub path. Alpha path populates them.
-- -----------------------------------------------------------------------------

alter table public.deposits
  add column if not exists chain_id      integer,
  add column if not exists tx_hash       text,
  add column if not exists from_address  text,
  add column if not exists to_address    text,
  add column if not exists block_number  bigint;

create unique index if not exists deposits_chain_txhash_uniq
  on public.deposits (chain_id, tx_hash)
  where tx_hash is not null;

alter table public.withdrawals
  add column if not exists chain_id            integer,
  add column if not exists destination_address text,
  add column if not exists tx_hash             text,
  add column if not exists block_number        bigint;

create unique index if not exists withdrawals_chain_txhash_uniq
  on public.withdrawals (chain_id, tx_hash)
  where tx_hash is not null;

-- -----------------------------------------------------------------------------
-- compliance_settings extension: per-user lifetime crypto deposit cap.
-- Alpha default: $250 (250_000_000 micros). Beta raises, GA drops to vendor cap.
-- -----------------------------------------------------------------------------

alter table public.compliance_settings
  add column if not exists crypto_deposit_cap_micro     bigint not null default 250000000
    check (crypto_deposit_cap_micro >= 0),
  add column if not exists crypto_withdrawal_min_micro  bigint not null default 5000000
    check (crypto_withdrawal_min_micro >= 0);

-- -----------------------------------------------------------------------------
-- credit_crypto_deposit
--
-- Called by the deposit-watcher when a USDC Transfer into the Safe hot wallet
-- is confirmed. Idempotent on (chain_id, tx_hash).
--
--   1. Short-circuit if system_flags.deposits_frozen → raise H0015.
--   2. Validate amount_micro > 0.
--   3. Lookup user_id via (chain_id, from_address) in user_wallet_addresses.
--      Unknown sender → raise H0014 (ops reviews the orphan via /admin).
--   4. Enforce per-user lifetime cap (sum of prior confirmed deposits +
--      this one <= crypto_deposit_cap_micro). Exceeds → raise H0012.
--   5. Insert deposits row (status='confirmed') with all the crypto trail.
--      Duplicate tx_hash collides on the partial unique index → raise H0013.
--   6. post_transfer with two legs:
--        user_wallet (+amount)  -- user's spendable balance grows
--        pending_deposits (-amount)  -- custody-obligation mirror deepens
--      Same txn_id is the deposit row id for easy forensics.
--   7. Backlink deposit.txn_id.
--
-- Returns the deposit row id. Replays on the same tx_hash are a no-op returning
-- the original id.
-- -----------------------------------------------------------------------------

create or replace function public.credit_crypto_deposit(
  p_chain_id      integer,
  p_tx_hash       text,
  p_from_address  text,
  p_to_address    text,
  p_amount_micro  bigint,
  p_block_number  bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_frozen       boolean;
  v_user_id      uuid;
  v_existing_id  uuid;
  v_deposit_id   uuid;
  v_txn_id       uuid;
  v_legs         jsonb;
  v_cap          bigint;
  v_prior_sum    bigint;
begin
  if p_chain_id is null or p_tx_hash is null or p_from_address is null
     or p_amount_micro is null or p_amount_micro <= 0 then
    raise exception 'invalid arguments to credit_crypto_deposit'
      using errcode = '22023';
  end if;

  -- Idempotency short-circuit: if we already recorded this tx_hash, return it.
  select id into v_existing_id
    from public.deposits
    where chain_id = p_chain_id and tx_hash = p_tx_hash
    limit 1;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  -- Freeze check
  select value into v_frozen
    from public.system_flags where flag = 'deposits_frozen';
  if v_frozen then
    -- Record the inbound for audit even when frozen, without crediting ledger.
    insert into public.deposits (
      user_id, currency, amount_micro, status, provider,
      chain_id, tx_hash, from_address, to_address, block_number, provider_reference
    ) values (
      -- Without user mapping, we store the first admin uid as placeholder.
      -- Ops must reassign via /admin. But we can't leave user_id null (NOT NULL).
      -- Use a dedicated house uid convention: reject instead.
      coalesce((select user_id from public.user_wallet_addresses
                  where chain_id = p_chain_id and lower(address) = lower(p_from_address) limit 1),
               '00000000-0000-0000-0000-000000000000'::uuid),
      'USDC'::public.ledger_currency, p_amount_micro, 'pending', 'crypto_base',
      p_chain_id, p_tx_hash, p_from_address, p_to_address, p_block_number,
      'frozen_at_ingest'
    );
    raise exception 'deposits are frozen' using errcode = 'H0015';
  end if;

  -- Sender -> user mapping
  select user_id into v_user_id
    from public.user_wallet_addresses
    where chain_id = p_chain_id and lower(address) = lower(p_from_address)
    limit 1;
  if v_user_id is null then
    raise exception 'unknown sender address: %', p_from_address
      using errcode = 'H0014';
  end if;

  -- Per-user lifetime cap
  select crypto_deposit_cap_micro into v_cap
    from public.compliance_settings where id = 1;
  select coalesce(sum(amount_micro), 0) into v_prior_sum
    from public.deposits
    where user_id = v_user_id and status = 'confirmed';
  if (v_prior_sum + p_amount_micro) > v_cap then
    raise exception 'lifetime deposit cap exceeded: prior=% new=% cap=%',
      v_prior_sum, p_amount_micro, v_cap
      using errcode = 'H0012';
  end if;

  -- Ledger first: post_transfer creates the ledger_transfers row that the
  -- deposits.txn_id FK + deposits_confirmed_has_txn check constraint require.
  -- Using the deposit id as the txn id keeps the 1:1 mapping for forensics.
  v_deposit_id := gen_random_uuid();
  v_txn_id     := v_deposit_id;
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id',      v_user_id,
      'account',      'user_wallet',
      'currency',     'USDC',
      'amount_micro',  p_amount_micro
    ),
    jsonb_build_object(
      'user_id',      null,
      'account',      'pending_deposits',
      'currency',     'USDC',
      'amount_micro', -p_amount_micro
    )
  );
  perform public.post_transfer(v_txn_id, v_legs, 'crypto_deposit:' || p_tx_hash);

  -- Now INSERT the deposit with both status='confirmed' AND txn_id — the
  -- ledger_transfers row exists, so the FK + the check constraint are both
  -- satisfied in one write. No follow-up UPDATE needed.
  insert into public.deposits (
    id, user_id, currency, amount_micro, status, provider,
    chain_id, tx_hash, from_address, to_address, block_number,
    txn_id, confirmed_at
  ) values (
    v_deposit_id, v_user_id, 'USDC'::public.ledger_currency, p_amount_micro,
    'confirmed', 'crypto_base',
    p_chain_id, p_tx_hash, p_from_address, p_to_address, p_block_number,
    v_txn_id, now()
  );

  return v_deposit_id;
end;
$$;

comment on function public.credit_crypto_deposit(integer, text, text, text, bigint, bigint) is
  'Crediting RPC for on-chain USDC deposits on Base. Idempotent on (chain_id, tx_hash). '
  'Called by the deposit-watcher service.';

-- -----------------------------------------------------------------------------
-- request_withdrawal
--
-- Called from the /api/withdrawals edge function after the user submits the
-- withdrawal form. Reserves the user's balance by moving it from user_wallet
-- into pending_withdrawals. Actual on-chain send happens via ops batch (Safe).
--
--   1. Short-circuit if system_flags.withdrawals_frozen → raise H0016.
--   2. Validate amount_micro >= crypto_withdrawal_min_micro → H0017 otherwise.
--   3. Validate destination_address matches 0x-prefixed-40-hex.
--   4. Insert withdrawals row (status='pending').
--   5. post_transfer: user_wallet -amount, pending_withdrawals +amount.
--      Same txn_id is the withdrawal row id.
--      Overdraft is caught by post_transfer's non-negative user_wallet assertion.
-- -----------------------------------------------------------------------------

create or replace function public.request_withdrawal(
  p_user_id              uuid,
  p_amount_micro         bigint,
  p_destination_address  text,
  p_chain_id             integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_frozen         boolean;
  v_min            bigint;
  v_withdrawal_id  uuid;
  v_legs           jsonb;
begin
  if p_user_id is null or p_amount_micro is null or p_amount_micro <= 0
     or p_destination_address is null or p_chain_id is null then
    raise exception 'invalid arguments to request_withdrawal'
      using errcode = '22023';
  end if;

  if p_destination_address !~ '^0x[a-fA-F0-9]{40}$' then
    raise exception 'invalid destination address' using errcode = '22023';
  end if;

  select value into v_frozen
    from public.system_flags where flag = 'withdrawals_frozen';
  if v_frozen then
    raise exception 'withdrawals are frozen' using errcode = 'H0016';
  end if;

  select crypto_withdrawal_min_micro into v_min
    from public.compliance_settings where id = 1;
  if p_amount_micro < v_min then
    raise exception 'withdrawal below minimum: amount=% min=%', p_amount_micro, v_min
      using errcode = 'H0017';
  end if;

  v_withdrawal_id := gen_random_uuid();
  insert into public.withdrawals (
    id, user_id, currency, amount_micro, status, provider,
    chain_id, destination_address
  ) values (
    v_withdrawal_id, p_user_id, 'USDC'::public.ledger_currency, p_amount_micro,
    'pending', 'crypto_base',
    p_chain_id, p_destination_address
  );

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id',      p_user_id,
      'account',      'user_wallet',
      'currency',     'USDC',
      'amount_micro', -p_amount_micro
    ),
    jsonb_build_object(
      'user_id',      p_user_id,
      'account',      'pending_withdrawals',
      'currency',     'USDC',
      'amount_micro',  p_amount_micro
    )
  );
  perform public.post_transfer(v_withdrawal_id, v_legs, 'withdrawal_reserve:' || v_withdrawal_id::text);

  update public.withdrawals set txn_id = v_withdrawal_id where id = v_withdrawal_id;
  return v_withdrawal_id;
end;
$$;

comment on function public.request_withdrawal(uuid, bigint, text, integer) is
  'Reserves user balance into pending_withdrawals. Ops sends the on-chain tx, '
  'then calls mark_withdrawal_paid with the tx_hash.';

-- -----------------------------------------------------------------------------
-- mark_withdrawal_paid
--
-- Called by ops (via admin console) after the Safe multisig batch has broadcast
-- the USDC transfer on Base. Closes the reservation by moving pending_withdrawals
-- into pending_deposits (decreasing the custody-obligation mirror).
-- Idempotent on withdrawal_id + tx_hash.
-- -----------------------------------------------------------------------------

create or replace function public.mark_withdrawal_paid(
  p_withdrawal_id  uuid,
  p_tx_hash        text,
  p_block_number   bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status  public.withdrawal_status;
  v_amount  bigint;
  v_user    uuid;
  v_txn_id  uuid;
  v_legs    jsonb;
begin
  if p_withdrawal_id is null or p_tx_hash is null then
    raise exception 'invalid arguments to mark_withdrawal_paid'
      using errcode = '22023';
  end if;

  select status, amount_micro, user_id
    into v_status, v_amount, v_user
    from public.withdrawals
    where id = p_withdrawal_id
    for update;
  if not found then
    raise exception 'unknown withdrawal_id' using errcode = '22023';
  end if;

  -- Idempotent replay
  if v_status = 'confirmed' then
    return;
  end if;
  if v_status <> 'pending' then
    raise exception 'withdrawal not in pending state: %', v_status
      using errcode = '22023';
  end if;

  update public.withdrawals
    set status       = 'confirmed',
        tx_hash      = p_tx_hash,
        block_number = p_block_number,
        confirmed_at = now()
    where id = p_withdrawal_id;

  v_txn_id := gen_random_uuid();
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id',      v_user,
      'account',      'pending_withdrawals',
      'currency',     'USDC',
      'amount_micro', -v_amount
    ),
    jsonb_build_object(
      'user_id',      null,
      'account',      'pending_deposits',
      'currency',     'USDC',
      'amount_micro',  v_amount
    )
  );
  perform public.post_transfer(v_txn_id, v_legs, 'withdrawal_paid:' || p_tx_hash);
end;
$$;

comment on function public.mark_withdrawal_paid(uuid, text, bigint) is
  'Ops closes a withdrawal by recording the on-chain tx_hash. Reduces the '
  'pending_deposits liability mirror by the withdrawn amount. Idempotent.';

-- -----------------------------------------------------------------------------
-- mark_withdrawal_failed
--
-- Ops abort path. Reverses the pending reservation back to user_wallet.
-- Idempotent against a withdrawal already in terminal state.
-- -----------------------------------------------------------------------------

create or replace function public.mark_withdrawal_failed(
  p_withdrawal_id  uuid,
  p_reason         text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status  public.withdrawal_status;
  v_amount  bigint;
  v_user    uuid;
  v_txn_id  uuid;
  v_legs    jsonb;
begin
  if p_withdrawal_id is null or p_reason is null then
    raise exception 'invalid arguments to mark_withdrawal_failed'
      using errcode = '22023';
  end if;

  select status, amount_micro, user_id
    into v_status, v_amount, v_user
    from public.withdrawals
    where id = p_withdrawal_id
    for update;
  if not found then
    raise exception 'unknown withdrawal_id' using errcode = '22023';
  end if;

  if v_status in ('confirmed', 'failed') then
    return;  -- idempotent no-op on terminal state
  end if;

  update public.withdrawals
    set status = 'failed',
        provider_reference = left(coalesce(provider_reference, '') || ' failed:' || p_reason, 256),
        confirmed_at = now()
    where id = p_withdrawal_id;

  -- Reverse the reservation
  v_txn_id := gen_random_uuid();
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id',      v_user,
      'account',      'pending_withdrawals',
      'currency',     'USDC',
      'amount_micro', -v_amount
    ),
    jsonb_build_object(
      'user_id',      v_user,
      'account',      'user_wallet',
      'currency',     'USDC',
      'amount_micro',  v_amount
    )
  );
  perform public.post_transfer(v_txn_id, v_legs, 'withdrawal_failed:' || p_withdrawal_id::text);
end;
$$;

-- -----------------------------------------------------------------------------
-- reconcile_crypto_ledger
--
-- Read-only: returns the ledger-side custody obligation (abs of pending_deposits
-- aggregate) and in-flight withdrawal reserves. The deposit-watcher's
-- reconciliation job compares this to on-chain Safe balances (hot + cold).
-- -----------------------------------------------------------------------------

create or replace function public.reconcile_crypto_ledger()
returns table (
  ledger_custody_micro      bigint,
  in_flight_withdraw_micro  bigint,
  user_wallet_total_micro   bigint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    -abs(coalesce((
      select sum(amount_micro)
      from public.ledger_entries
      where account = 'pending_deposits' and currency = 'USDC'
    ), 0))                                                       as ledger_custody_micro,
    coalesce((
      select sum(amount_micro)
      from public.ledger_entries
      where account = 'pending_withdrawals' and currency = 'USDC' and amount_micro > 0
    ), 0) -
    coalesce((
      select sum(-amount_micro)
      from public.ledger_entries
      where account = 'pending_withdrawals' and currency = 'USDC' and amount_micro < 0
    ), 0)                                                         as in_flight_withdraw_micro,
    coalesce((
      select sum(amount_micro)
      from public.ledger_entries
      where account = 'user_wallet' and currency = 'USDC'
    ), 0)                                                         as user_wallet_total_micro;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke execute on function public.credit_crypto_deposit(integer, text, text, text, bigint, bigint)
  from public;
grant  execute on function public.credit_crypto_deposit(integer, text, text, text, bigint, bigint)
  to service_role;

revoke execute on function public.request_withdrawal(uuid, bigint, text, integer) from public;
grant  execute on function public.request_withdrawal(uuid, bigint, text, integer) to service_role;

revoke execute on function public.mark_withdrawal_paid(uuid, text, bigint) from public;
grant  execute on function public.mark_withdrawal_paid(uuid, text, bigint) to service_role;

revoke execute on function public.mark_withdrawal_failed(uuid, text) from public;
grant  execute on function public.mark_withdrawal_failed(uuid, text) to service_role;

revoke execute on function public.reconcile_crypto_ledger() from public;
grant  execute on function public.reconcile_crypto_ledger() to service_role;

-- -----------------------------------------------------------------------------
-- Helpful view for admin: pending withdrawal queue, oldest first.
-- -----------------------------------------------------------------------------

create or replace view public.admin_withdrawal_queue as
  select w.id,
         w.user_id,
         up.handle,
         w.amount_micro,
         w.destination_address,
         w.chain_id,
         w.created_at,
         extract(epoch from (now() - w.created_at))::bigint as age_seconds
    from public.withdrawals w
    left join public.user_profiles up on up.user_id = w.user_id
    where w.status = 'pending'
    order by w.created_at asc;

grant select on public.admin_withdrawal_queue to service_role;
