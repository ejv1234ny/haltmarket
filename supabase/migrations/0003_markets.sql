-- =============================================================================
-- 0003_markets.sql  --  Phase 3: market lifecycle engine
--
-- On every new halt, atomically create a market with:
--   * 22 bins: 1 tail-low + 20 log-spaced main bins + 1 tail-high
--   * status state machine open → locked → resolved | refunded
--   * closes_at = halt_time + 90s (Phase 4 place-bet enforces both
--     server-side status AND closes_at vs now())
--
-- Schema additions land ADR-0002's action item #7:
--   * markets.closest_bonus_bps int not null default 700
--   * bets.predicted_price numeric(12,4) not null
--   * market_resolutions.closest_bonus_winner_user_id uuid
--   * market_resolutions.closest_bonus_amount_micro bigint
--
-- Migration is additive only (AGENTS.md §5.4) — no ALTER on prior phases'
-- objects. Phase 4 bet-placement + Phase 5 resolution math will reference the
-- tables and RPC defined here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.market_status as enum ('open', 'locked', 'resolved', 'refunded');
create type public.bet_status    as enum ('active', 'settled', 'refunded');
create type public.payout_source as enum ('bin', 'closest_bonus', 'refund');

-- -----------------------------------------------------------------------------
-- markets: one per halt, atomically created by a trigger on halts INSERT.
-- -----------------------------------------------------------------------------

create table public.markets (
  id                  uuid primary key default gen_random_uuid(),
  halt_id             uuid not null unique
                        references public.halts(id) on delete restrict,
  status              public.market_status not null default 'open',
  last_price          numeric(12,4) not null check (last_price > 0),
  opened_at           timestamptz not null default now(),
  closes_at           timestamptz not null,
  locked_at           timestamptz,
  resolved_at         timestamptz,
  refunded_at         timestamptz,
  currency            public.ledger_currency not null default 'USDC',
  total_pool_micro    bigint not null default 0 check (total_pool_micro >= 0),
  fee_bps             int not null default 500
                        check (fee_bps between 0 and 10000),
  closest_bonus_bps   int not null default 700
                        check (closest_bonus_bps between 0 and 10000),
  winning_bin_id      uuid,
  constraint markets_fee_plus_bonus_under_10000
    check (fee_bps + closest_bonus_bps < 10000),
  -- Note: we intentionally do NOT require closes_at > opened_at. Late-ingested
  -- halts (RSS / monitor latency > 90s) will create markets that `lock_due_markets`
  -- locks on its next tick. Phase 4 place-bet enforces `now() < closes_at`
  -- independently, so such markets simply never accept bets — correct behavior.
  constraint markets_status_timestamps check (
       (status = 'open'     and locked_at is null and resolved_at is null and refunded_at is null)
    or (status = 'locked'   and locked_at is not null and resolved_at is null and refunded_at is null)
    or (status = 'resolved' and locked_at is not null and resolved_at is not null and refunded_at is null)
    or (status = 'refunded' and resolved_at is null and refunded_at is not null)
  )
);

create index markets_status_closes_at_idx on public.markets (status, closes_at);
create index markets_halt_id_idx          on public.markets (halt_id);
create index markets_open_markets_idx     on public.markets (opened_at desc)
  where status = 'open';

comment on table public.markets is
  'One market per halt. Created atomically by the halts-INSERT trigger. '
  'Status state machine enforced by the markets_status_transition trigger.';

-- -----------------------------------------------------------------------------
-- bins: 22 per market (1 tail-low + 20 log-spaced main + 1 tail-high).
-- -----------------------------------------------------------------------------

create table public.bins (
  id              uuid primary key default gen_random_uuid(),
  market_id       uuid not null references public.markets(id) on delete restrict,
  idx             int  not null check (idx between 0 and 21),
  low_price       numeric(12,4) not null check (low_price >= 0),
  high_price      numeric(12,4) not null,
  is_tail_low     boolean not null default false,
  is_tail_high    boolean not null default false,
  stake_micro     bigint  not null default 0 check (stake_micro >= 0),
  constraint bins_price_ordered check (low_price < high_price),
  constraint bins_tail_flags_exclusive check (not (is_tail_low and is_tail_high)),
  constraint bins_unique_idx unique (market_id, idx)
);

create index bins_market_idx              on public.bins (market_id, idx);
create index bins_price_lookup_idx        on public.bins (market_id, low_price, high_price);

-- Foreign key from markets.winning_bin_id → bins.id, declared after bins table.
alter table public.markets
  add constraint markets_winning_bin_fk
    foreign key (winning_bin_id) references public.bins(id);

comment on table public.bins is
  'Price bins for a market. idx 0 = tail-low, 1..20 = log-spaced main, 21 = tail-high.';

-- -----------------------------------------------------------------------------
-- bets: one row per user stake into a bin. predicted_price preserves the
-- exact numeric input from the bet-placement UI so Phase 5 can compute the
-- closest-to-the-pin bonus winner.
-- -----------------------------------------------------------------------------

create table public.bets (
  id                uuid primary key default gen_random_uuid(),
  market_id         uuid not null references public.markets(id) on delete restrict,
  bin_id            uuid not null references public.bins(id)    on delete restrict,
  user_id           uuid not null references auth.users(id)     on delete restrict,
  stake_micro       bigint not null check (stake_micro > 0),
  predicted_price   numeric(12,4) not null check (predicted_price > 0),
  placed_at         timestamptz not null default now(),
  status            public.bet_status not null default 'active',
  idempotency_key   text not null check (length(btrim(idempotency_key)) > 0),
  constraint bets_user_idem_unique unique (user_id, idempotency_key)
);

create index bets_market_bin_idx    on public.bets (market_id, bin_id);
create index bets_user_market_idx   on public.bets (user_id, market_id);
create index bets_market_predicted_price_idx
  on public.bets (market_id, predicted_price);

comment on table public.bets is
  'User stakes. predicted_price is the exact numeric input; bin_id is the '
  'server-derived bin that contains it. Phase 5 resolution uses both.';

comment on column public.bets.predicted_price is
  'Exact price the user typed. Phase 5 picks the user with min '
  '|predicted_price - reopen_price| as the closest-to-the-pin bonus winner '
  '(per ADR-0002).';

-- -----------------------------------------------------------------------------
-- market_resolutions: one row per resolved market. Captures fee/bonus/main
-- split for audit and for rendering receipts.
-- -----------------------------------------------------------------------------

create table public.market_resolutions (
  market_id                        uuid primary key
                                     references public.markets(id) on delete restrict,
  reopen_price                     numeric(12,4) not null check (reopen_price > 0),
  winning_bin_id                   uuid not null references public.bins(id),
  gross_pool_micro                 bigint not null check (gross_pool_micro >= 0),
  fee_micro                        bigint not null check (fee_micro >= 0),
  closest_bonus_micro              bigint not null default 0
                                     check (closest_bonus_micro >= 0),
  closest_bonus_winner_user_id     uuid references auth.users(id),
  main_payout_pool_micro           bigint not null check (main_payout_pool_micro >= 0),
  ledger_txn_id                    uuid not null
                                     references public.ledger_transfers(txn_id),
  resolved_at                      timestamptz not null default now(),
  constraint market_resolutions_buckets_sum
    check (fee_micro + closest_bonus_micro + main_payout_pool_micro
           = gross_pool_micro),
  constraint market_resolutions_bonus_winner_requires_amount
    check ((closest_bonus_winner_user_id is null and closest_bonus_micro = 0)
        or (closest_bonus_winner_user_id is not null and closest_bonus_micro > 0))
);

comment on column public.market_resolutions.closest_bonus_winner_user_id is
  'User whose predicted_price was nearest the reopen. NULL when no bonus '
  'awarded (e.g. no bets, or tie policy diverts to main pool in edge cases).';

comment on column public.market_resolutions.closest_bonus_micro is
  'Closest-to-the-pin bonus amount in micros. Defaults to 0 when no bonus '
  'winner. When > 0 and split across tied users, their per-user payouts live '
  'in the payouts table with source=closest_bonus.';

-- -----------------------------------------------------------------------------
-- payouts: one row per credit leg at resolution. A single user may appear
-- twice on the same market (bin share + closest_bonus).
-- -----------------------------------------------------------------------------

create table public.payouts (
  id              uuid primary key default gen_random_uuid(),
  bet_id          uuid not null references public.bets(id)    on delete restrict,
  market_id       uuid not null references public.markets(id) on delete restrict,
  user_id         uuid not null references auth.users(id)     on delete restrict,
  source          public.payout_source not null,
  amount_micro    bigint not null check (amount_micro > 0),
  ledger_txn_id   uuid not null references public.ledger_transfers(txn_id),
  created_at      timestamptz not null default now(),
  constraint payouts_bet_source_unique unique (bet_id, source)
);

create index payouts_market_idx on public.payouts (market_id);
create index payouts_user_idx   on public.payouts (user_id);

comment on table public.payouts is
  'Per-leg resolution credits. A bet can have at most one payout per source '
  '(bin/closest_bonus/refund). Ledger txn_id backreferences the post_transfer '
  'call that actually moved the money.';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.markets             enable row level security;
alter table public.bins                enable row level security;
alter table public.bets                enable row level security;
alter table public.market_resolutions  enable row level security;
alter table public.payouts             enable row level security;

-- Markets, bins, and resolutions are public (every user can view any market).
create policy markets_select_public            on public.markets
  for select using (true);
create policy bins_select_public               on public.bins
  for select using (true);
create policy market_resolutions_select_public on public.market_resolutions
  for select using (true);

-- Bets & payouts: readable by owner only.
create policy bets_select_own    on public.bets    for select using (auth.uid() = user_id);
create policy payouts_select_own on public.payouts for select using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies on any of the above → writes only via
-- service_role (BYPASSRLS) or SECURITY DEFINER RPCs below.

-- -----------------------------------------------------------------------------
-- Status-transition trigger: reject any UPDATE that violates the state machine.
-- The canonical walk is: open → locked → resolved. Refunded is a terminal
-- alternative from open, locked, or resolved (refunding a resolved market is
-- allowed — operator override — but rare).
-- -----------------------------------------------------------------------------

create or replace function public.markets_enforce_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;
  -- Valid transitions
  if    old.status = 'open'     and new.status in ('locked', 'refunded')      then return new;
  elsif old.status = 'locked'   and new.status in ('resolved', 'refunded')    then return new;
  elsif old.status = 'resolved' and new.status = 'refunded'                   then return new;
  end if;

  raise exception 'illegal market status transition % -> %', old.status, new.status
    using errcode = '23514';
end;
$$;

create trigger markets_status_transition
  before update of status on public.markets
  for each row execute function public.markets_enforce_status_transition();

-- -----------------------------------------------------------------------------
-- compute_bin_ladder(last_price): pure function. Returns 22 rows (idx 0..21):
--   * idx 0  : tail-low   [0,              0.5 * last_price)
--   * idx 1  : [0.5 * last_price,             0.5 * last_price * 4^(1/20))
--   * ...
--   * idx 20 : [0.5 * last_price * 4^(19/20), 2.0 * last_price)
--   * idx 21 : tail-high  [2.0 * last_price,  numeric_max)
--
-- log-spaced between 0.5P and 2.0P means the ratio between consecutive main-bin
-- lows is constant: (2P/0.5P)^(1/20) = 4^(1/20) ≈ 1.07177.
-- -----------------------------------------------------------------------------

-- 99999999.9999 is the largest value a numeric(12,4) column can hold; using it
-- as the tail-high upper bound keeps the bin bounds representable in bins.high_price.
create or replace function public.compute_bin_ladder(p_last_price numeric(12,4))
returns table (
  idx          int,
  low_price    numeric(12,4),
  high_price   numeric(12,4),
  is_tail_low  boolean,
  is_tail_high boolean
)
language plpgsql
immutable
parallel safe
as $$
declare
  v_i          int;
  v_low        numeric;
  v_high       numeric;
  v_tail_max   numeric := 99999999.9999;
  v_half_p     numeric := p_last_price * 0.5;
  v_double_p   numeric := p_last_price * 2.0;
  v_ratio      numeric := power(4.0::numeric, 1.0 / 20.0); -- 4^(1/20)
  v_low_rnd    numeric(12,4);
  v_high_rnd   numeric(12,4);
begin
  if p_last_price is null or p_last_price <= 0 then
    raise exception 'compute_bin_ladder: last_price must be positive, got %',
      p_last_price using errcode = '22023';
  end if;

  -- Tail-low: [0, v_half_p)
  v_low_rnd  := 0;
  v_high_rnd := round(v_half_p, 4);
  -- Degenerate case: if half_p rounds to 0 (e.g. last_price < 0.0002), bump to
  -- the smallest representable increment so low_price < high_price holds.
  if v_high_rnd <= v_low_rnd then
    v_high_rnd := 0.0001;
  end if;
  return query select 0, v_low_rnd, v_high_rnd, true, false;

  -- Main bins 1..20
  v_low := v_half_p;
  for v_i in 1..20 loop
    v_high     := v_low * v_ratio;
    v_low_rnd  := round(v_low,  4);
    v_high_rnd := round(v_high, 4);
    -- Guard against collapsed bins for very small prices.
    if v_high_rnd <= v_low_rnd then
      v_high_rnd := v_low_rnd + 0.0001;
    end if;
    return query select v_i, v_low_rnd, v_high_rnd, false, false;
    v_low := v_high;
  end loop;

  -- Tail-high: [2P, v_tail_max)
  v_low_rnd  := round(v_double_p, 4);
  v_high_rnd := v_tail_max;
  if v_high_rnd <= v_low_rnd then
    v_high_rnd := v_low_rnd + 0.0001;
  end if;
  return query select 21, v_low_rnd, v_high_rnd, false, true;
end;
$$;

comment on function public.compute_bin_ladder(numeric) is
  '22 bins for a given last_price: idx 0 tail-low, 1..20 log-spaced main, 21 tail-high. '
  'Log spacing: consecutive main-bin lows differ by factor 4^(1/20). '
  'Per AGENTS.md §Phase 3 + ADR-0002 the ladder shape is frozen — bet UX uses '
  'numeric predicted_price, client/server derive bin from this function.';

-- -----------------------------------------------------------------------------
-- create_market(halt_id): SECURITY DEFINER entry point for the halts-INSERT
-- trigger. Returns the new market id, or NULL when the halt has no last_price
-- (Polygon was unreachable at ingest; we still record the halt but don't open
-- a market because there's no ladder anchor).
-- -----------------------------------------------------------------------------

create or replace function public.create_market(p_halt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_halt        public.halts%rowtype;
  v_market_id   uuid;
  v_closes_at   timestamptz;
  v_bin         record;
begin
  select * into strict v_halt from public.halts where id = p_halt_id;

  if v_halt.last_price is null then
    -- No anchor price → cannot build ladder. Phase 2 monitor logs these; we
    -- leave the halt row as-is (reopen still captured by Phase 5 if it arrives).
    return null;
  end if;

  -- Already have a market for this halt? (UNIQUE halt_id would throw, but we
  -- want the idempotent no-op path for safety when trigger fires on re-insert.)
  select id into v_market_id from public.markets where halt_id = p_halt_id;
  if v_market_id is not null then
    return v_market_id;
  end if;

  v_closes_at := v_halt.halt_time + interval '90 seconds';

  insert into public.markets (halt_id, last_price, closes_at)
  values (p_halt_id, v_halt.last_price, v_closes_at)
  returning id into v_market_id;

  for v_bin in select * from public.compute_bin_ladder(v_halt.last_price)
  loop
    insert into public.bins
      (market_id, idx, low_price, high_price, is_tail_low, is_tail_high)
    values
      (v_market_id, v_bin.idx, v_bin.low_price, v_bin.high_price,
       v_bin.is_tail_low, v_bin.is_tail_high);
  end loop;

  return v_market_id;
end;
$$;

comment on function public.create_market(uuid) is
  'Atomically create a market + its 22-bin ladder for a halt. Idempotent: '
  'second call for the same halt returns the existing market_id.';

-- -----------------------------------------------------------------------------
-- halts-INSERT trigger: fires create_market() automatically. Phase 2 inserts
-- halts via insert_halt(); this trigger runs immediately after so the market
-- exists before the Realtime broadcast lands on the client.
-- -----------------------------------------------------------------------------

create or replace function public.halts_after_insert_create_market()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.create_market(new.id);
  return null;
end;
$$;

create trigger halts_create_market_after_insert
  after insert on public.halts
  for each row execute function public.halts_after_insert_create_market();

-- -----------------------------------------------------------------------------
-- find_bin_for_price(market_id, price): used by Phase 4 place-bet to map a
-- user's predicted_price to the bin containing it. Returns the bin id or NULL
-- when the price is outside the ladder (which shouldn't happen because idx 0
-- and 21 cover [0, tail_max)).
-- -----------------------------------------------------------------------------

create or replace function public.find_bin_for_price(
  p_market_id uuid,
  p_price     numeric(12,4)
)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select id
  from public.bins
  where market_id = p_market_id
    and p_price >= low_price
    and p_price < high_price
  order by idx
  limit 1;
$$;

comment on function public.find_bin_for_price(uuid, numeric) is
  'Return bin id whose [low_price, high_price) contains p_price. '
  'Tail-low covers [0, 0.5P); tail-high covers [2P, 99999999.9999). '
  'NULL only if p_price is negative or exceeds 99999999.9999 (never in practice).';

-- -----------------------------------------------------------------------------
-- lock_due_markets(): scheduled every 15 seconds by a Supabase edge function
-- (Phase 3 ships the DB side; the edge function lives in
-- supabase/functions/lock-due-markets/). Transitions any 'open' market whose
-- closes_at has passed to 'locked'.
-- -----------------------------------------------------------------------------

create or replace function public.lock_due_markets()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  with due as (
    select id from public.markets
    where status = 'open'
      and closes_at <= now()
    for update skip locked
  )
  update public.markets m
     set status    = 'locked',
         locked_at = now()
    from due
   where m.id = due.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.lock_due_markets() is
  'Bulk transition expired-open markets to locked. Called every 15s by the '
  'lock-due-markets scheduled edge function. SKIP LOCKED avoids head-of-line '
  'blocking if a market is being resolved concurrently.';

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke execute on function public.compute_bin_ladder(numeric) from public;
grant  execute on function public.compute_bin_ladder(numeric) to service_role;

revoke execute on function public.create_market(uuid) from public;
grant  execute on function public.create_market(uuid) to service_role;

revoke execute on function public.find_bin_for_price(uuid, numeric) from public;
grant  execute on function public.find_bin_for_price(uuid, numeric) to service_role;

revoke execute on function public.lock_due_markets() from public;
grant  execute on function public.lock_due_markets() to service_role;
