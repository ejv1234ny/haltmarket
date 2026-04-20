-- =============================================================================
-- 0005_resolution.sql  --  Phase 5: market resolution + refund RPCs
--
-- Implements ADR-0002 §Resolution Math atomically inside two SECURITY
-- DEFINER entry points that the Python resolver (`apps/resolver/`) calls:
--
--   * public.resolve_market(halt_id, reopen_price, reopen_at, reopen_source)
--     — executes the 10-step math block: fee + closest-to-pin bonus + main
--     pool pro-rata to winning-bin bets; writes halts.reopen_*, market_
--     resolutions, payouts (bin + closest_bonus); calls post_transfer once
--     with balanced legs; flips market.status open|locked → resolved.
--
--   * public.refund_market(halt_id, reason)
--     — returns every bet's stake to its user in one post_transfer;
--     writes per-bet payouts (source='refund'); flips market.status
--     open|locked|resolved → refunded.
--
-- Both functions are idempotent by design:
--   * resolve_market on an already-resolved market: replay existing
--     market_resolutions row, return it unchanged (no double-pay).
--   * refund_market on an already-refunded market: no-op.
--
-- This is the ONLY place ADR-0002's closest-to-pin bonus is computed.
-- Phase 6+ (notifications, admin) must read from market_resolutions and
-- payouts — never recompute, or the resolver and the reader will diverge
-- on rounding dust.
--
-- Error taxonomy (SQLSTATE 'R0xx' user class):
--   R0001 market_not_resolvable        — market not in locked state
--   R0002 market_not_refundable        — market already resolved (Phase 9
--                                        admin will override)
--   R0003 market_not_found             — halt has no market
--   R0004 halt_not_found               — halt_id unknown
--   R0099 invalid_input
--
-- Rounding rule: integer math everywhere. Any remainder from floor
-- division (main-pool pro-rata, bonus/N split) is absorbed into the
-- house_fees leg so the transfer still sums to 0 and no money is lost.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- refund_reason tracking column on markets. Additive — lets the ops team and
-- Phase 9 admin know WHY a market was refunded (timeout vs operator override)
-- without a separate audit table. Nullable on resolved / open markets.
-- -----------------------------------------------------------------------------

alter table public.markets
  add column if not exists refund_reason text;

-- -----------------------------------------------------------------------------
-- list_resolvable_markets(cooldown_seconds, refund_deadline_minutes)
--
-- Returns the set of markets the resolver should act on in its next poll.
-- Two buckets:
--   * `action = 'resolve'`: status='locked' AND halts.halt_end_time known
--     AND halts.halt_end_time < now() - cooldown_seconds AND halts.reopen
--     is not already captured. The resolver fetches Polygon for these.
--   * `action = 'refund_timeout'`: status='locked' AND locked_at older than
--     refund_deadline_minutes AND no reopen yet. The resolver refunds.
--
-- `action = 'recovery'`: status='locked' but halt_end_time IS NULL (monitor
-- never captured an end time). Resolver falls back to locked_at + 90s as the
-- probable reopen window and treats as regular resolve.
-- -----------------------------------------------------------------------------

create or replace function public.list_resolvable_markets(
  p_cooldown_seconds        int default 5,
  p_refund_deadline_minutes int default 15
)
returns table (
  market_id          uuid,
  halt_id            uuid,
  symbol             text,
  halt_end_time      timestamptz,
  locked_at          timestamptz,
  total_pool_micro   bigint,
  action             text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    m.id           as market_id,
    h.id           as halt_id,
    h.symbol       as symbol,
    h.halt_end_time,
    m.locked_at,
    m.total_pool_micro,
    case
      when m.locked_at is not null
           and m.locked_at < now() - make_interval(mins => p_refund_deadline_minutes)
        then 'refund_timeout'
      else 'resolve'
    end as action
  from public.markets m
  join public.halts   h on h.id = m.halt_id
  where m.status = 'locked'
    and h.reopen_price is null
    and (
      -- Ready to resolve: halt_end_time + cooldown has passed, OR
      (h.halt_end_time is not null
         and h.halt_end_time < now() - make_interval(secs => p_cooldown_seconds))
      -- Refund-timeout path is eligible even without halt_end_time — locked_at
      -- age alone fires the timeout.
      or (m.locked_at is not null
          and m.locked_at < now() - make_interval(mins => p_refund_deadline_minutes))
    )
  order by m.locked_at nulls last
  limit 200;
$$;

comment on function public.list_resolvable_markets(int, int) is
  'Returns up to 200 locked markets the resolver should process this tick. '
  'The `action` column tells the resolver whether to fetch Polygon (resolve) '
  'or short-circuit to refund_market (refund_timeout).';

revoke execute on function public.list_resolvable_markets(int, int) from public;
grant  execute on function public.list_resolvable_markets(int, int) to service_role;

-- -----------------------------------------------------------------------------
-- resolve_market(halt_id, reopen_price, reopen_at, reopen_source)
--
-- Atomic ADR-0002 resolution. Called by the Python resolver once Polygon
-- has returned a reopen price. Idempotent by market_resolutions PK.
-- -----------------------------------------------------------------------------

create or replace function public.resolve_market(
  p_halt_id        uuid,
  p_reopen_price   numeric(12,4),
  p_reopen_at      timestamptz,
  p_reopen_source  text
)
returns table (
  market_id                     uuid,
  winning_bin_id                uuid,
  gross_pool_micro              bigint,
  fee_micro                     bigint,
  closest_bonus_micro           bigint,
  closest_bonus_winner_user_id  uuid,
  main_payout_pool_micro        bigint,
  ledger_txn_id                 uuid,
  idempotent_replay             boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_halt          public.halts%rowtype;
  v_market        public.markets%rowtype;
  v_existing      public.market_resolutions%rowtype;
  v_winning_bin   public.bins%rowtype;
  v_gross         bigint;
  v_fee           bigint;
  v_bonus         bigint;
  v_main_pool     bigint;
  v_winning_stake bigint;
  v_tied_count    int;
  v_per_user_bonus bigint;
  v_bonus_dust    bigint;
  v_bin_dust      bigint;
  v_actual_fee    bigint;
  v_closest_user  uuid;
  v_txn_id        uuid := gen_random_uuid();
  v_legs          jsonb := '[]'::jsonb;
  v_total_paid    bigint := 0;
  v_min_distance  numeric(12,4);
  v_rec           record;
begin
  -- 1. Input validation.
  if p_halt_id is null then
    raise exception 'halt_id required' using errcode = 'R0099';
  end if;
  if p_reopen_price is null or p_reopen_price <= 0 then
    raise exception 'reopen_price must be positive' using errcode = 'R0099';
  end if;
  if p_reopen_at is null then
    raise exception 'reopen_at required' using errcode = 'R0099';
  end if;
  if p_reopen_source is null or length(btrim(p_reopen_source)) = 0 then
    raise exception 'reopen_source required' using errcode = 'R0099';
  end if;

  -- 2. Advisory lock per halt to serialize concurrent resolver invocations.
  perform pg_advisory_xact_lock(hashtext(p_halt_id::text));

  -- 3. Load halt + market.
  select * into v_halt from public.halts where id = p_halt_id;
  if not found then
    raise exception 'halt_not_found' using errcode = 'R0004';
  end if;
  select * into v_market from public.markets where halt_id = p_halt_id for update;
  if not found then
    raise exception 'market_not_found' using errcode = 'R0003';
  end if;

  -- 4. Idempotency: if already resolved, return the existing resolution row.
  if v_market.status = 'resolved' then
    select * into v_existing from public.market_resolutions
      where market_id = v_market.id;
    if found then
      return query select
        v_existing.market_id,
        v_existing.winning_bin_id,
        v_existing.gross_pool_micro,
        v_existing.fee_micro,
        v_existing.closest_bonus_micro,
        v_existing.closest_bonus_winner_user_id,
        v_existing.main_payout_pool_micro,
        v_existing.ledger_txn_id,
        true;
      return;
    end if;
    -- Edge case: status='resolved' but no market_resolutions row (zero-pool
    -- resolve path, below). Treat as idempotent no-op with zeros.
    return query select
      v_market.id, v_market.winning_bin_id,
      0::bigint, 0::bigint, 0::bigint, null::uuid, 0::bigint,
      null::uuid, true;
    return;
  end if;

  -- 5. Only locked markets can be resolved. open → resolved is not a legal
  -- transition; the caller should wait for lock_due_markets to flip status.
  if v_market.status <> 'locked' then
    raise exception 'market_not_resolvable: status=%', v_market.status
      using errcode = 'R0001';
  end if;

  -- 6. Find winning bin. Tail bins cover the entire numeric(12,4) range so
  -- this should never be NULL; treat NULL as an invariant violation.
  select * into v_winning_bin
    from public.bins
   where market_id = v_market.id
     and p_reopen_price >= low_price
     and p_reopen_price < high_price
   order by idx
   limit 1;
  if not found then
    raise exception 'no bin contains reopen_price=% for market=%',
      p_reopen_price, v_market.id using errcode = 'R0099';
  end if;

  -- 7. Record the reopen on the halt row (idempotent — only fires when
  -- reopen_price IS NULL).
  perform public.record_reopen(
    p_halt_id, p_reopen_price, p_reopen_at, p_reopen_source
  );

  -- 8. Zero-pool short-circuit. Nothing to ledger; skip market_resolutions
  -- (winning_bin_id is captured on markets). Flip status and exit.
  v_gross := v_market.total_pool_micro;
  if v_gross = 0 then
    update public.markets
       set status         = 'resolved',
           winning_bin_id = v_winning_bin.id,
           resolved_at    = now()
     where id = v_market.id;
    return query select
      v_market.id, v_winning_bin.id,
      0::bigint, 0::bigint, 0::bigint, null::uuid, 0::bigint,
      null::uuid, false;
    return;
  end if;

  -- 9. Compute fee + bonus + main_pool from bps (5% / 7% defaults). Integer
  -- division truncates — any dust rolls into the actual fee at the end.
  v_fee   := v_gross * v_market.fee_bps / 10000;
  v_bonus := v_gross * v_market.closest_bonus_bps / 10000;
  v_main_pool := v_gross - v_fee - v_bonus;

  -- 10. Closest-to-the-pin: smallest |predicted_price - reopen_price|
  -- across ALL bets on this market (per ADR-0002 — not just winning-bin).
  -- Ties share bonus/N equally. Dust joins the house fee.
  select min(abs(predicted_price - p_reopen_price))
    into v_min_distance
    from public.bets
   where market_id = v_market.id;

  v_tied_count := 0;
  if v_min_distance is not null then
    -- Count distinct tied users. Multiple bets from the same user at the
    -- same distance count once — the bonus is per-user, not per-bet.
    select count(distinct user_id) into v_tied_count
      from public.bets
     where market_id = v_market.id
       and abs(predicted_price - p_reopen_price) = v_min_distance;
  end if;

  if v_tied_count > 0 then
    v_per_user_bonus := v_bonus / v_tied_count;
    v_bonus_dust := v_bonus - v_per_user_bonus * v_tied_count;
  else
    -- No bettors → bonus folds into house fees. (Cannot happen in practice:
    -- v_gross > 0 implies at least one bet exists.)
    v_per_user_bonus := 0;
    v_bonus_dust := v_bonus;
  end if;

  -- 11. Main-pool pro-rata. Zero winning-bin stake means no winners; the
  -- entire main_pool rolls into house fees (edge case when reopen_price
  -- lands in a bin nobody bet on).
  select coalesce(sum(stake_micro), 0)::bigint into v_winning_stake
    from public.bets
   where bin_id = v_winning_bin.id;

  -- 12. Build transfer legs. Start with the debit from market_pool and the
  -- fee credit; append bonus + bin-winner legs as we compute them.
  v_legs := jsonb_build_array(
    jsonb_build_object(
      'account',       'market_pool',
      'currency',      v_market.currency::text,
      'amount_micro',  (-v_gross)::text,
      'ref_market_id', v_market.id::text
    )
  );

  -- 13. Append one leg per tied closest user. Remember the first (lowest
  -- user_id by ordering) as the canonical bonus winner on market_resolutions;
  -- when tied, the market_resolutions row records only one winner, while
  -- payouts records all of them.
  if v_tied_count > 0 and v_per_user_bonus > 0 then
    for v_rec in
      select distinct user_id
        from public.bets
       where market_id = v_market.id
         and abs(predicted_price - p_reopen_price) = v_min_distance
       order by user_id
    loop
      v_legs := v_legs || jsonb_build_array(jsonb_build_object(
        'user_id',       v_rec.user_id::text,
        'account',       'user_wallet',
        'currency',      v_market.currency::text,
        'amount_micro',  v_per_user_bonus::text,
        'ref_market_id', v_market.id::text
      ));
      if v_closest_user is null then
        v_closest_user := v_rec.user_id;
      end if;
    end loop;
  end if;

  -- 14. Append one leg per winning-bin bet pro-rata. Track total paid so we
  -- know the dust to roll back into fees.
  v_bin_dust := v_main_pool;
  if v_winning_stake > 0 then
    for v_rec in
      select id, user_id, stake_micro
        from public.bets
       where bin_id = v_winning_bin.id
       order by placed_at, id
    loop
      declare
        v_share bigint := v_main_pool * v_rec.stake_micro / v_winning_stake;
      begin
        if v_share > 0 then
          v_legs := v_legs || jsonb_build_array(jsonb_build_object(
            'user_id',       v_rec.user_id::text,
            'account',       'user_wallet',
            'currency',      v_market.currency::text,
            'amount_micro',  v_share::text,
            'ref_market_id', v_market.id::text,
            'ref_bet_id',    v_rec.id::text
          ));
          v_total_paid := v_total_paid + v_share;
        end if;
      end;
    end loop;
    v_bin_dust := v_main_pool - v_total_paid;
  end if;

  -- 15. House-fee leg = base fee + bonus-dust + bin-dust. Always positive
  -- because each component is >=0 and v_gross > 0 here.
  v_actual_fee := v_fee + v_bonus_dust + v_bin_dust;
  if v_actual_fee > 0 then
    v_legs := v_legs || jsonb_build_array(jsonb_build_object(
      'account',       'house_fees',
      'currency',      v_market.currency::text,
      'amount_micro',  v_actual_fee::text,
      'ref_market_id', v_market.id::text
    ));
  end if;

  -- 16. One atomic post_transfer for the whole resolution. SUM=0 verified
  -- inside post_transfer itself; drift-impossible.
  perform public.post_transfer(v_txn_id, v_legs, 'market_resolve');

  -- 17. Write market_resolutions (audit + payout-receipt row).
  insert into public.market_resolutions (
    market_id, reopen_price, winning_bin_id,
    gross_pool_micro, fee_micro, closest_bonus_micro,
    closest_bonus_winner_user_id, main_payout_pool_micro,
    ledger_txn_id
  ) values (
    v_market.id, p_reopen_price, v_winning_bin.id,
    v_gross, v_actual_fee,
    -- Report bonus = per_user * N (actual amount paid out in bonus legs),
    -- not the gross bps slice — matches the sum constraint on this table.
    v_per_user_bonus * v_tied_count,
    v_closest_user, v_main_pool - v_bin_dust,
    v_txn_id
  );

  -- 18. payouts rows: one per winning-bin bet (source='bin') + one per
  -- closest-bonus bet per tied user (source='closest_bonus'). bet_id for
  -- the bonus payout is that user's deterministic "closest" bet — we pick
  -- the lowest placed_at/id at the min-distance tier for stable replay.
  if v_winning_stake > 0 then
    insert into public.payouts
      (bet_id, market_id, user_id, source, amount_micro, ledger_txn_id)
    select
      b.id, v_market.id, b.user_id, 'bin',
      v_main_pool * b.stake_micro / v_winning_stake,
      v_txn_id
    from public.bets b
    where b.bin_id = v_winning_bin.id
      and v_main_pool * b.stake_micro / v_winning_stake > 0;
  end if;

  if v_tied_count > 0 and v_per_user_bonus > 0 then
    insert into public.payouts
      (bet_id, market_id, user_id, source, amount_micro, ledger_txn_id)
    select
      closest.bet_id, v_market.id, closest.user_id, 'closest_bonus',
      v_per_user_bonus, v_txn_id
    from (
      select distinct on (user_id)
        id as bet_id, user_id
      from public.bets
      where market_id = v_market.id
        and abs(predicted_price - p_reopen_price) = v_min_distance
      order by user_id, placed_at, id
    ) closest
    on conflict (bet_id, source) do nothing;
  end if;

  -- 19. Flip status + stamp resolved_at.
  update public.markets
     set status         = 'resolved',
         winning_bin_id = v_winning_bin.id,
         resolved_at    = now()
   where id = v_market.id;

  return query select
    v_market.id, v_winning_bin.id,
    v_gross, v_actual_fee, v_per_user_bonus * v_tied_count,
    v_closest_user, v_main_pool - v_bin_dust,
    v_txn_id, false;
end;
$$;

comment on function public.resolve_market(uuid, numeric, timestamptz, text) is
  'Phase 5 atomic ADR-0002 resolution. Idempotent on market_id via the '
  'market_resolutions PK; safe to replay on resolver restart.';

revoke execute on function public.resolve_market(uuid, numeric, timestamptz, text)
  from public;
grant  execute on function public.resolve_market(uuid, numeric, timestamptz, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- refund_market(halt_id, reason)
--
-- Return every bet's stake to its user. One post_transfer with N+1 legs
-- (−market_pool + N user_wallet credits). Writes per-bet payouts with
-- source='refund'. Idempotent (no-op on already-refunded markets).
-- -----------------------------------------------------------------------------

create or replace function public.refund_market(
  p_halt_id uuid,
  p_reason  text
)
returns table (
  market_id          uuid,
  refunded_bet_count int,
  gross_refund_micro bigint,
  ledger_txn_id      uuid,
  idempotent_replay  boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_market      public.markets%rowtype;
  v_txn_id      uuid := gen_random_uuid();
  v_legs        jsonb := '[]'::jsonb;
  v_refund_sum  bigint := 0;
  v_bet_count   int := 0;
  v_rec         record;
begin
  if p_halt_id is null then
    raise exception 'halt_id required' using errcode = 'R0099';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason required' using errcode = 'R0099';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_halt_id::text));

  select * into v_market from public.markets
    where halt_id = p_halt_id for update;
  if not found then
    raise exception 'market_not_found' using errcode = 'R0003';
  end if;

  -- Idempotent replay: market already refunded → return the existing totals.
  if v_market.status = 'refunded' then
    select count(*)::int, coalesce(sum(amount_micro), 0)::bigint
      into v_bet_count, v_refund_sum
      from public.payouts
     where market_id = v_market.id and source = 'refund';
    return query select
      v_market.id, v_bet_count, v_refund_sum,
      null::uuid, true;
    return;
  end if;

  if v_market.status = 'resolved' then
    raise exception 'market_not_refundable: already resolved'
      using errcode = 'R0002';
  end if;

  -- Aggregate per-user refund totals so each user_wallet leg is distinct.
  -- post_transfer accepts duplicate (user, account, currency) legs, but one
  -- leg per user keeps ledger_entries readable at audit time.
  for v_rec in
    select user_id, sum(stake_micro)::bigint as total_stake
      from public.bets
     where market_id = v_market.id
     group by user_id
     order by user_id
  loop
    v_legs := v_legs || jsonb_build_array(jsonb_build_object(
      'user_id',       v_rec.user_id::text,
      'account',       'user_wallet',
      'currency',      v_market.currency::text,
      'amount_micro',  v_rec.total_stake::text,
      'ref_market_id', v_market.id::text
    ));
    v_refund_sum := v_refund_sum + v_rec.total_stake;
  end loop;

  select count(*)::int into v_bet_count
    from public.bets where market_id = v_market.id;

  if v_refund_sum > 0 then
    -- Prepend the debit from market_pool so sum(legs) = 0.
    v_legs := jsonb_build_array(jsonb_build_object(
      'account',       'market_pool',
      'currency',      v_market.currency::text,
      'amount_micro',  (-v_refund_sum)::text,
      'ref_market_id', v_market.id::text
    )) || v_legs;

    perform public.post_transfer(v_txn_id, v_legs, 'market_refund: ' || p_reason);

    insert into public.payouts
      (bet_id, market_id, user_id, source, amount_micro, ledger_txn_id)
    select b.id, v_market.id, b.user_id, 'refund', b.stake_micro, v_txn_id
      from public.bets b
     where b.market_id = v_market.id;
  else
    -- Zero-stake market: no ledger txn needed. Still flip status.
    v_txn_id := null;
  end if;

  update public.markets
     set status        = 'refunded',
         refunded_at   = now(),
         refund_reason = p_reason
   where id = v_market.id;

  return query select
    v_market.id, v_bet_count, v_refund_sum, v_txn_id, false;
end;
$$;

comment on function public.refund_market(uuid, text) is
  'Phase 5 atomic refund. Returns every bet stake to its user in one '
  'post_transfer, writes payouts(source=refund) rows, flips market status. '
  'Idempotent on market status.';

revoke execute on function public.refund_market(uuid, text) from public;
grant  execute on function public.refund_market(uuid, text) to service_role;
