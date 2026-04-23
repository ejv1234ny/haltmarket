-- =============================================================================
-- 0007_compliance.sql  --  CFTC compliance gates
--
-- Adds KYC + geo-blocking + aggregate-cap enforcement to place_bet(...).
-- No money moves without passing all three:
--   * kyc_status = 'approved'  (or disabled via require_kyc flag)
--   * user's geo_country not in blocked_regions
--   * aggregate open/locked exposure across all markets <= aggregate_cap_micro
--
-- Three new SQLSTATE codes (all 4xx-mappable by the edge function):
--   H0009 kyc_required            — user hasn't completed KYC
--   H0010 region_blocked          — user country is on the blocklist
--   H0011 aggregate_cap_exceeded  — user's total open exposure would exceed cap
--
-- A single-row `compliance_settings` keeps CFTC limits in one place so ops can
-- tune them without redeploying. Defaults mirror CLAUDE.md §CFTC Compliance:
--   * aggregate cap: $15,000 (15_000_000_000 micros)
--   * per-outcome limit: $2,500 (enforced by existing per-market $1,000 cap,
--     which is stricter; left unchanged for now)
--   * require_kyc: true
-- =============================================================================

-- -----------------------------------------------------------------------------
-- user_profiles compliance columns (migration 0006 added the table).
-- -----------------------------------------------------------------------------

alter table public.user_profiles
  add column if not exists kyc_status  text default 'none'
    check (kyc_status in ('none','pending','approved','rejected')),
  add column if not exists geo_country char(2);

create index if not exists user_profiles_kyc_status_idx
  on public.user_profiles (kyc_status);

-- -----------------------------------------------------------------------------
-- blocked_regions: ISO-3166 alpha-2 country codes ops flags as off-limits.
-- Readable publicly (users can see why they're blocked); writes are service
-- role only.
-- -----------------------------------------------------------------------------

create table if not exists public.blocked_regions (
  country  char(2) primary key,
  reason   text not null default 'CFTC compliance'
);

alter table public.blocked_regions enable row level security;

create policy blocked_regions_select_public on public.blocked_regions
  for select using (true);

-- -----------------------------------------------------------------------------
-- compliance_settings: single-row config table. Enforced in place_bet.
-- -----------------------------------------------------------------------------

create table if not exists public.compliance_settings (
  id                        smallint primary key default 1,
  require_kyc               boolean not null default true,
  aggregate_cap_micro       bigint  not null default 15000000000
                              check (aggregate_cap_micro >= 0),
  updated_at                timestamptz not null default now(),
  constraint compliance_settings_singleton check (id = 1)
);

insert into public.compliance_settings (id) values (1)
  on conflict (id) do nothing;

alter table public.compliance_settings enable row level security;

create policy compliance_settings_select_public on public.compliance_settings
  for select using (true);

-- -----------------------------------------------------------------------------
-- Updated place_bet with compliance gates. Same signature as 0004 so all
-- grants carry over. Body adds three checks before the existing 1..12 flow.
-- -----------------------------------------------------------------------------

create or replace function public.place_bet(
  p_user_id          uuid,
  p_market_id        uuid,
  p_predicted_price  numeric,
  p_stake_micro      bigint,
  p_idempotency_key  text
)
returns table (
  bet_id                uuid,
  bin_id                uuid,
  bin_idx               int,
  predicted_price       numeric(12,4),
  stake_micro           bigint,
  placed_at             timestamptz,
  new_bin_stake_micro   bigint,
  new_total_pool_micro  bigint,
  idempotent_replay     boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_market       public.markets%rowtype;
  v_bin          public.bins%rowtype;
  v_bet          public.bets%rowtype;
  v_existing     public.bets%rowtype;
  v_balance      bigint;
  v_aggregate    bigint;
  v_rate_count   int;
  v_txn_id       uuid := gen_random_uuid();
  v_legs         jsonb;
  v_new_bin      bigint;
  v_new_pool     bigint;
  v_replay_idx   int;
  v_require_kyc  boolean;
  v_agg_cap      bigint;
  v_kyc_status   text;
  v_geo_country  char(2);
  v_total_open   bigint;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = 'H0099';
  end if;
  if p_market_id is null then
    raise exception 'market_not_found' using errcode = 'H0008';
  end if;
  if p_stake_micro is null or p_stake_micro <= 0 then
    raise exception 'stake_micro must be positive' using errcode = 'H0099';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key required' using errcode = 'H0099';
  end if;
  if p_predicted_price is null or p_predicted_price <= 0 then
    raise exception 'predicted_price must be positive' using errcode = 'H0099';
  end if;
  if coalesce(scale(p_predicted_price), 0) > 4 then
    raise exception 'invalid_price_precision' using errcode = 'H0007';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_user_id::text),
    hashtext(p_market_id::text)
  );

  -- Compliance gates — run before idempotency so KYC failures surface even
  -- on replay. The idempotent-replay short-circuit only fires for a bet that
  -- was already accepted, i.e., one where the user had valid KYC at the time.
  select require_kyc, aggregate_cap_micro
    into v_require_kyc, v_agg_cap
    from public.compliance_settings where id = 1;
  -- Defaults if the row is somehow missing (fresh DB without the seed).
  v_require_kyc := coalesce(v_require_kyc, true);
  v_agg_cap     := coalesce(v_agg_cap, 15000000000);

  select kyc_status, geo_country
    into v_kyc_status, v_geo_country
    from public.user_profiles where user_id = p_user_id;

  if v_require_kyc and coalesce(v_kyc_status, 'none') <> 'approved' then
    raise exception 'kyc_required' using errcode = 'H0009';
  end if;

  if v_geo_country is not null then
    perform 1 from public.blocked_regions where country = v_geo_country;
    if found then
      raise exception 'region_blocked' using errcode = 'H0010';
    end if;
  end if;

  -- 3. Idempotency replay.
  select * into v_existing
    from public.bets
   where user_id = p_user_id
     and market_id = p_market_id
     and idempotency_key = p_idempotency_key
   limit 1;
  if v_existing.id is not null then
    select stake_micro, idx into v_new_bin, v_replay_idx
      from public.bins where id = v_existing.bin_id;
    select total_pool_micro into v_new_pool
      from public.markets where id = p_market_id;
    return query select
      v_existing.id, v_existing.bin_id, v_replay_idx,
      v_existing.predicted_price, v_existing.stake_micro, v_existing.placed_at,
      v_new_bin, v_new_pool, true;
    return;
  end if;

  perform 1 from public.bets
    where user_id = p_user_id
      and idempotency_key = p_idempotency_key;
  if found then
    raise exception 'duplicate_idempotency_key' using errcode = 'H0003';
  end if;

  select * into v_market from public.markets
    where id = p_market_id for update;
  if not found then
    raise exception 'market_not_found' using errcode = 'H0008';
  end if;
  if v_market.status <> 'open' or v_market.closes_at <= now() then
    raise exception 'market_closed' using errcode = 'H0001';
  end if;

  select * into v_bin
    from public.bins
   where market_id = p_market_id
     and p_predicted_price >= low_price
     and p_predicted_price < high_price
   order by idx
   limit 1;
  if not found then
    raise exception 'price_outside_ladder' using errcode = 'H0006';
  end if;

  select count(*)::int into v_rate_count
    from public.bets
   where user_id = p_user_id
     and placed_at > now() - interval '1 second';
  if v_rate_count >= 10 then
    raise exception 'rate_limited' using errcode = 'H0004';
  end if;

  select coalesce(sum(stake_micro), 0)::bigint into v_aggregate
    from public.bets
   where user_id = p_user_id
     and market_id = p_market_id;
  if v_aggregate + p_stake_micro > 1000000000 then
    raise exception 'exceeds_per_market_limit' using errcode = 'H0005';
  end if;

  -- Aggregate CFTC cap: user's total exposure on open/locked markets must
  -- not exceed aggregate_cap_micro after this bet. Resolved/refunded markets
  -- don't count — money has already left the pool.
  select coalesce(sum(b.stake_micro), 0)::bigint into v_total_open
    from public.bets b
    join public.markets m on m.id = b.market_id
   where b.user_id = p_user_id
     and m.status in ('open', 'locked');
  if v_total_open + p_stake_micro > v_agg_cap then
    raise exception 'aggregate_cap_exceeded' using errcode = 'H0011';
  end if;

  select balance_micro into v_balance
    from public.wallets
   where user_id = p_user_id
     and account = 'user_wallet'
     and currency = v_market.currency
   for update;
  if v_balance is null or v_balance < p_stake_micro then
    raise exception 'insufficient_balance' using errcode = 'H0002';
  end if;

  begin
    insert into public.bets (
      market_id, bin_id, user_id, stake_micro,
      predicted_price, idempotency_key
    ) values (
      p_market_id, v_bin.id, p_user_id, p_stake_micro,
      p_predicted_price::numeric(12,4), p_idempotency_key
    )
    returning * into v_bet;
  exception when unique_violation then
    raise exception 'duplicate_idempotency_key' using errcode = 'H0003';
  end;

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'user_id',       p_user_id::text,
      'account',       'user_wallet',
      'currency',      v_market.currency::text,
      'amount_micro',  (-p_stake_micro)::text,
      'ref_market_id', p_market_id::text,
      'ref_bet_id',    v_bet.id::text
    ),
    jsonb_build_object(
      'account',       'market_pool',
      'currency',      v_market.currency::text,
      'amount_micro',  p_stake_micro::text,
      'ref_market_id', p_market_id::text,
      'ref_bet_id',    v_bet.id::text
    )
  );
  begin
    perform public.post_transfer(v_txn_id, v_legs, 'bet_placed');
  exception when check_violation then
    if sqlerrm ilike '%negative%' then
      raise exception 'insufficient_balance' using errcode = 'H0002';
    end if;
    raise;
  end;

  update public.bins
     set stake_micro = stake_micro + p_stake_micro
   where id = v_bin.id
  returning stake_micro into v_new_bin;

  update public.markets
     set total_pool_micro = total_pool_micro + p_stake_micro
   where id = p_market_id
  returning total_pool_micro into v_new_pool;

  return query select
    v_bet.id, v_bin.id, v_bin.idx,
    v_bet.predicted_price, v_bet.stake_micro, v_bet.placed_at,
    v_new_bin, v_new_pool, false;
end;
$$;

comment on function public.place_bet(uuid, uuid, numeric, bigint, text) is
  'Phase 4 hot-path entry point + 0007 CFTC compliance gates: KYC, '
  'geo-blocking, aggregate cap, per-market cap, rate limit, overdraft check, '
  'ledger transfer, bin + pool update. See migration headers for SQLSTATE taxonomy.';
