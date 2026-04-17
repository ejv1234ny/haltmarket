-- =============================================================================
-- 0001_ledger.sql  --  Phase 1: double-entry ledger subsystem
--
-- Implements ADR-0001 (docs/adrs/ADR-0001-ledger-subsystem.md):
--   * append-only ledger_entries, globally SUM(amount_micro) = 0
--   * wallets as reconcilable cache, entries win on disagreement
--   * SECURITY DEFINER post_transfer(txn_id, legs jsonb, reason) writes N legs
--     atomically and rejects duplicate txn_id via ledger_transfers PK
--   * reconcile_wallet_cache(user_id) rebuilds cache from entries
--   * invariant helpers ledger_global_sum() / ledger_wallet_drift(limit)
--
-- Non-goals for Phase 1: deposit/withdrawal providers (Phase 8),
-- bet/market tables (Phase 3+). This migration ships only the money primitives.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.ledger_account as enum (
  'user_wallet',
  'market_pool',
  'house_fees',
  'pending_deposits',
  'pending_withdrawals'
);

create type public.ledger_currency as enum ('USDC');

create type public.deposit_status as enum ('pending', 'confirmed', 'failed');
create type public.withdrawal_status as enum ('pending', 'confirmed', 'failed');

-- -----------------------------------------------------------------------------
-- ledger_transfers: one row per post_transfer call. PK on txn_id gives us
-- idempotency-by-collision (duplicate txn_id → unique_violation, caller retries
-- as a no-op). ledger_entries FKs here, so orphan legs are impossible.
-- -----------------------------------------------------------------------------

create table public.ledger_transfers (
  txn_id       uuid primary key,
  reason       text not null check (length(btrim(reason)) > 0),
  created_at   timestamptz not null default now()
);

comment on table public.ledger_transfers is
  'One row per atomic multi-leg transfer. PK on txn_id enforces idempotency; '
  'ledger_entries FKs here.';

-- -----------------------------------------------------------------------------
-- ledger_entries: the append-only log. Every money movement writes >=2 legs
-- sharing a txn_id, summing to zero. CI guards against mutating statements in
-- new migrations; runtime triggers below guard against mutations from any role.
-- -----------------------------------------------------------------------------

create table public.ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  txn_id         uuid not null references public.ledger_transfers(txn_id),
  user_id        uuid references auth.users(id) on delete restrict,
  account        public.ledger_account not null,
  currency       public.ledger_currency not null,
  amount_micro   bigint not null check (amount_micro <> 0),
  ref_market_id  uuid,
  ref_bet_id     uuid,
  reason         text not null,
  created_at     timestamptz not null default now(),
  constraint ledger_entries_user_wallet_needs_user
    check (account <> 'user_wallet' or user_id is not null)
);

create index ledger_entries_txn_id_idx
  on public.ledger_entries (txn_id);

create index ledger_entries_user_currency_created_idx
  on public.ledger_entries (user_id, currency, created_at desc);

create index ledger_entries_account_currency_created_idx
  on public.ledger_entries (account, currency, created_at desc);

create index ledger_entries_ref_market_idx
  on public.ledger_entries (ref_market_id)
  where ref_market_id is not null;

comment on table public.ledger_entries is
  'Append-only double-entry ledger. See docs/ledger.md. '
  'UPDATE/DELETE/TRUNCATE rejected by trigger; mutations in migrations rejected by CI.';

-- Structural append-only enforcement. Runs for every role including service_role;
-- the only way to correct state is via reversing entries.
create or replace function public.ledger_entries_deny_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger_entries is append-only (ADR-0001); use reversing entries';
end;
$$;

create trigger ledger_entries_no_update
  before update on public.ledger_entries
  for each row execute function public.ledger_entries_deny_mutation();

create trigger ledger_entries_no_delete
  before delete on public.ledger_entries
  for each row execute function public.ledger_entries_deny_mutation();

create trigger ledger_entries_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function public.ledger_entries_deny_mutation();

-- -----------------------------------------------------------------------------
-- wallets: reconcilable cache. One row per (user_id, account, currency).
-- NULLS NOT DISTINCT lets us upsert pool rows (user_id IS NULL) cleanly.
-- -----------------------------------------------------------------------------

create table public.wallets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete restrict,
  account        public.ledger_account not null,
  currency       public.ledger_currency not null,
  balance_micro  bigint not null default 0,
  updated_at     timestamptz not null default now(),
  constraint wallets_user_wallet_needs_user
    check (account <> 'user_wallet' or user_id is not null),
  constraint wallets_uniq
    unique nulls not distinct (user_id, account, currency)
);

create index wallets_user_idx on public.wallets (user_id) where user_id is not null;

comment on table public.wallets is
  'Cache of ledger_entries sums, keyed by (user_id, account, currency). '
  'Updated atomically by post_transfer. On drift, reconcile_wallet_cache rebuilds.';

-- -----------------------------------------------------------------------------
-- deposits / withdrawals: scaffolding for Phase 8. Wired to a transfer txn_id
-- once confirmed, so the ledger is always the source of truth for funds moved.
-- -----------------------------------------------------------------------------

create table public.deposits (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete restrict,
  currency             public.ledger_currency not null,
  amount_micro         bigint not null check (amount_micro > 0),
  status               public.deposit_status not null default 'pending',
  provider             text not null default 'stub',
  provider_reference   text,
  txn_id               uuid references public.ledger_transfers(txn_id),
  created_at           timestamptz not null default now(),
  confirmed_at         timestamptz,
  constraint deposits_confirmed_has_txn
    check (status <> 'confirmed' or txn_id is not null)
);

create index deposits_user_status_idx on public.deposits (user_id, status);

create table public.withdrawals (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete restrict,
  currency             public.ledger_currency not null,
  amount_micro         bigint not null check (amount_micro > 0),
  status               public.withdrawal_status not null default 'pending',
  provider             text not null default 'stub',
  provider_reference   text,
  txn_id               uuid references public.ledger_transfers(txn_id),
  created_at           timestamptz not null default now(),
  confirmed_at         timestamptz,
  constraint withdrawals_confirmed_has_txn
    check (status <> 'confirmed' or txn_id is not null)
);

create index withdrawals_user_status_idx on public.withdrawals (user_id, status);

-- -----------------------------------------------------------------------------
-- post_transfer(txn_id, legs jsonb, reason text)
--
-- Atomic multi-leg write. Callers (edge functions) should open a SERIALIZABLE
-- transaction. Inside the function we also:
--   * reject duplicate txn_id via ledger_transfers PK
--   * validate leg shape (account, currency, amount_micro != 0)
--   * assert sum(amount_micro) = 0 across legs
--   * upsert each affected wallet cache row in the same transaction
--   * assert every touched user_wallet row ends up balance_micro >= 0
--
-- The user_wallet non-negative assertion is the final stop against overdraft.
-- Place-bet / initiate-withdrawal still check eagerly for fast 4xx feedback.
-- -----------------------------------------------------------------------------

create or replace function public.post_transfer(
  p_txn_id uuid,
  p_legs   jsonb,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sum              bigint := 0;
  v_leg              jsonb;
  v_user_id          uuid;
  v_account          public.ledger_account;
  v_currency         public.ledger_currency;
  v_amount           bigint;
  v_ref_market_id    uuid;
  v_ref_bet_id       uuid;
  v_touched_users    uuid[] := array[]::uuid[];
  v_bad_balance      bigint;
begin
  if p_txn_id is null then
    raise exception 'txn_id is required' using errcode = '22004';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason is required' using errcode = '22004';
  end if;
  if p_legs is null
     or jsonb_typeof(p_legs) <> 'array'
     or jsonb_array_length(p_legs) < 2 then
    raise exception 'legs must be a JSON array with at least 2 entries'
      using errcode = '22023';
  end if;

  -- Idempotency: unique violation on txn_id means "already posted".
  insert into public.ledger_transfers (txn_id, reason)
  values (p_txn_id, p_reason);

  for v_leg in select * from jsonb_array_elements(p_legs)
  loop
    if jsonb_typeof(v_leg) <> 'object' then
      raise exception 'each leg must be a JSON object' using errcode = '22023';
    end if;

    v_user_id       := nullif(v_leg->>'user_id', '')::uuid;
    v_account       := (v_leg->>'account')::public.ledger_account;
    v_currency      := (v_leg->>'currency')::public.ledger_currency;
    v_amount        := (v_leg->>'amount_micro')::bigint;
    v_ref_market_id := nullif(v_leg->>'ref_market_id', '')::uuid;
    v_ref_bet_id    := nullif(v_leg->>'ref_bet_id', '')::uuid;

    if v_account is null then
      raise exception 'leg.account is required' using errcode = '22004';
    end if;
    if v_currency is null then
      raise exception 'leg.currency is required' using errcode = '22004';
    end if;
    if v_amount is null or v_amount = 0 then
      raise exception 'leg.amount_micro must be non-zero' using errcode = '22004';
    end if;
    if v_account = 'user_wallet' and v_user_id is null then
      raise exception 'user_wallet leg requires user_id' using errcode = '22004';
    end if;

    insert into public.ledger_entries (
      txn_id, user_id, account, currency, amount_micro,
      ref_market_id, ref_bet_id, reason
    ) values (
      p_txn_id, v_user_id, v_account, v_currency, v_amount,
      v_ref_market_id, v_ref_bet_id, p_reason
    );

    insert into public.wallets (
      user_id, account, currency, balance_micro, updated_at
    ) values (
      v_user_id, v_account, v_currency, v_amount, now()
    )
    on conflict (user_id, account, currency) do update
       set balance_micro = public.wallets.balance_micro + excluded.balance_micro,
           updated_at = now();

    if v_account = 'user_wallet' then
      v_touched_users := v_touched_users || v_user_id;
    end if;

    v_sum := v_sum + v_amount;
  end loop;

  if v_sum <> 0 then
    raise exception 'legs do not sum to zero: %', v_sum using errcode = '23514';
  end if;

  if array_length(v_touched_users, 1) > 0 then
    select min(w.balance_micro) into v_bad_balance
    from public.wallets w
    where w.account = 'user_wallet'
      and w.user_id = any (v_touched_users);
    if v_bad_balance is not null and v_bad_balance < 0 then
      raise exception 'user_wallet balance would go negative (%), refusing',
        v_bad_balance
        using errcode = '23514';
    end if;
  end if;
end;
$$;

comment on function public.post_transfer(uuid, jsonb, text) is
  'Atomic multi-leg ledger write. See ADR-0001 §Decision. '
  'Service-role callers only; caller should open a SERIALIZABLE transaction.';

-- -----------------------------------------------------------------------------
-- reconcile_wallet_cache(user_id): operator-only rebuild of one user's cache
-- from ledger_entries. Called from runbook-drift.md step 5.
-- -----------------------------------------------------------------------------

create or replace function public.reconcile_wallet_cache(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;

  delete from public.wallets where user_id = p_user_id;

  insert into public.wallets (user_id, account, currency, balance_micro, updated_at)
  select user_id, account, currency, sum(amount_micro), now()
  from public.ledger_entries
  where user_id = p_user_id
  group by user_id, account, currency;
end;
$$;

comment on function public.reconcile_wallet_cache(uuid) is
  'Rebuilds wallets cache for one user from ledger_entries. '
  'Operator-only; invoked from runbook-drift.md.';

-- -----------------------------------------------------------------------------
-- Invariant helpers — read-only, used by the hourly edge function.
-- -----------------------------------------------------------------------------

create or replace function public.ledger_global_sum()
returns bigint
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce(sum(amount_micro), 0)::bigint from public.ledger_entries;
$$;

comment on function public.ledger_global_sum() is
  'Returns SUM(amount_micro) across all ledger_entries. MUST be 0. '
  'Hourly invariant check pages Discord on drift.';

create or replace function public.ledger_wallet_drift(p_sample_limit int default 1000)
returns table (
  user_id              uuid,
  account              public.ledger_account,
  currency             public.ledger_currency,
  cache_balance_micro  bigint,
  entries_sum_micro    bigint,
  drift_micro          bigint
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with sampled as (
    select w.user_id, w.account, w.currency, w.balance_micro
    from public.wallets w
    where w.user_id is not null
    order by random()
    limit greatest(coalesce(p_sample_limit, 1000), 1)
  ),
  summed as (
    select e.user_id, e.account, e.currency,
           coalesce(sum(e.amount_micro), 0)::bigint as entries_sum
    from public.ledger_entries e
    join sampled s
      on s.user_id = e.user_id
     and s.account = e.account
     and s.currency = e.currency
    group by e.user_id, e.account, e.currency
  )
  select
    s.user_id,
    s.account,
    s.currency,
    s.balance_micro as cache_balance_micro,
    coalesce(sm.entries_sum, 0) as entries_sum_micro,
    (s.balance_micro - coalesce(sm.entries_sum, 0))::bigint as drift_micro
  from sampled s
  left join summed sm
    on sm.user_id = s.user_id
   and sm.account = s.account
   and sm.currency = s.currency
  where s.balance_micro <> coalesce(sm.entries_sum, 0);
$$;

comment on function public.ledger_wallet_drift(int) is
  'Returns sampled wallet rows whose cached balance_micro disagrees with '
  'SUM(ledger_entries.amount_micro). Empty result = all sampled caches consistent.';

-- -----------------------------------------------------------------------------
-- RLS: clients read own rows only; all writes go through SECURITY DEFINER RPCs.
-- -----------------------------------------------------------------------------

alter table public.ledger_transfers enable row level security;
alter table public.ledger_entries   enable row level security;
alter table public.wallets          enable row level security;
alter table public.deposits         enable row level security;
alter table public.withdrawals      enable row level security;

alter table public.ledger_entries force row level security;
alter table public.wallets        force row level security;

create policy wallets_select_own
  on public.wallets for select
  using (auth.uid() = user_id);

create policy ledger_entries_select_own
  on public.ledger_entries for select
  using (auth.uid() = user_id);

create policy deposits_select_own
  on public.deposits for select
  using (auth.uid() = user_id);

create policy withdrawals_select_own
  on public.withdrawals for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies on any of the above → only the service role
-- (which BYPASSRLS) and SECURITY DEFINER functions below can write.

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

-- Only service_role may call money-moving RPCs. authenticated/anon cannot craft
-- their own legs.
revoke execute on function public.post_transfer(uuid, jsonb, text)
  from public;
grant  execute on function public.post_transfer(uuid, jsonb, text)
  to service_role;

revoke execute on function public.reconcile_wallet_cache(uuid)
  from public;
grant  execute on function public.reconcile_wallet_cache(uuid)
  to service_role;

-- Invariant helpers are read-only; authenticated users don't need them.
revoke execute on function public.ledger_global_sum()          from public;
grant  execute on function public.ledger_global_sum()          to service_role;
revoke execute on function public.ledger_wallet_drift(int)     from public;
grant  execute on function public.ledger_wallet_drift(int)     to service_role;
