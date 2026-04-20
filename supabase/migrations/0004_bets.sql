-- =============================================================================
-- 0004_bets.sql  --  Phase 4: bet placement hot path (place_bet RPC)
--
-- Ships a single SECURITY DEFINER entry point `place_bet(...)` that the
-- Phase 4 edge function (supabase/functions/place-bet/) calls once per
-- bet-placement request. Everything below — idempotency replay, status +
-- closes_at gate, bin lookup, rate limit, per-market aggregate cap,
-- overdraft check, ledger transfer, bets insert, bins + markets totals —
-- runs inside the single transaction that PostgREST opens around the RPC
-- invocation. Correctness properties:
--
--   * Per-user-per-market advisory xact lock serializes races from the
--     same user on the same market (rate-limit race, aggregate-cap race,
--     idempotency-replay race).
--   * SELECT ... FOR UPDATE on markets + wallets rows pins the invariants
--     we check (market is open, user has balance) for the rest of the txn.
--   * `bets_user_idem_unique (user_id, idempotency_key)` from 0003 is the
--     hard gate — a duplicate insert raises 23505 even if every prior
--     check slipped through.
--   * All money movement still flows through Phase 1 `post_transfer`, so
--     the ADR-0001 SUM=0 invariant holds by construction.
--
-- Error taxonomy (SQLSTATE, used by the edge function to produce 4xx JSON):
--   H0001 market_closed                — status<>'open' or closes_at <= now()
--   H0002 insufficient_balance         — wallets.balance_micro < stake_micro
--   H0003 duplicate_idempotency_key    — (user_id, idempotency_key) in use
--                                        on a DIFFERENT market (strict uniq)
--   H0004 rate_limited                 — >10 bets in the last rolling second
--   H0005 exceeds_per_market_limit     — (agg + stake) > $1000 / user / market
--   H0006 price_outside_ladder         — find_bin_for_price() → NULL
--   H0007 invalid_price_precision      — scale(predicted_price) > 4
--   H0008 market_not_found             — markets.id missing
--   H0099 invalid_input                — generic validation (null / non-pos)
--
-- Classes H0…HZ are the Postgres-reserved user-defined SQLSTATE range; the
-- edge function matches on the 5-char code, not the message, so error-text
-- tweaks in follow-ups do not break the client contract.
--
-- Non-goals for Phase 4: resolution (Phase 5), refunds (Phase 5), push
-- notifications on bet-placed (Phase 6). This migration is additive only —
-- no ALTER on prior-phase objects, per AGENTS.md §5.4.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Per-user / per-market stake aggregate. A small index on (user_id, market_id)
-- already exists (bets_user_market_idx from 0003), so the aggregate-cap sum
-- runs from the index without a full table scan.
--
-- The rate-limit check uses a partial index on placed_at for rows in the
-- last minute. A BRIN index isn't selective enough at this scale and a plain
-- btree on placed_at is fine — the predicate prunes to a handful of rows.
-- -----------------------------------------------------------------------------

create index if not exists bets_user_placed_at_idx
  on public.bets (user_id, placed_at desc);

-- -----------------------------------------------------------------------------
-- Constants. $1000 aggregate cap lives alongside the function so operators
-- tuning the cap have one place to look. Rate-limit constants likewise.
-- -----------------------------------------------------------------------------

-- 1_000_000_000 micros == $1000 (6 decimal places of micros)
-- 10 bets / 1 second rolling window

-- -----------------------------------------------------------------------------
-- place_bet(p_user_id, p_market_id, p_predicted_price, p_stake_micro,
--           p_idempotency_key)
--
-- Returns one row with the bet receipt + post-write state of the bin and
-- market pool, so the edge function can broadcast `bin_delta` without a
-- second round-trip. `idempotent_replay = true` signals "we found an
-- existing bet with this (user, market, idempotency_key); nothing was
-- written this call."
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
-- RETURN TABLE output column names (`placed_at`, `stake_micro`, etc.) would
-- otherwise shadow bets.placed_at / bins.stake_micro inside SQL statements
-- in this function body. `use_column` tells PL/pgSQL to resolve ambiguous
-- references to the table column, which is what every query below expects.
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
begin
  -- 1. Input validation. The edge function mirrors these checks for 400s,
  -- but we repeat them server-side so direct service-role callers are safe.
  if p_user_id is null then
    raise exception 'user_id required' using errcode = 'H0099';
  end if;
  if p_market_id is null then
    raise exception 'market_not_found' using errcode = 'H0008';
  end if;
  if p_stake_micro is null or p_stake_micro <= 0 then
    raise exception 'stake_micro must be positive' using errcode = 'H0099';
  end if;
  if p_idempotency_key is null
     or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'idempotency_key required' using errcode = 'H0099';
  end if;
  if p_predicted_price is null or p_predicted_price <= 0 then
    raise exception 'predicted_price must be positive' using errcode = 'H0099';
  end if;
  if coalesce(scale(p_predicted_price), 0) > 4 then
    raise exception 'invalid_price_precision' using errcode = 'H0007';
  end if;

  -- 2. Advisory xact lock: hash(user_id, market_id). Serializes same-user-
  -- same-market bets so the rate-limit + aggregate-cap + idempotency checks
  -- below are race-free without needing SERIALIZABLE. Released on txn end.
  -- The two-int overload of pg_advisory_xact_lock takes int4 args — hashtext
  -- returns int4, so no cast is needed (and a ::bigint cast would wrongly
  -- route to the one-bigint overload).
  perform pg_advisory_xact_lock(
    hashtext(p_user_id::text),
    hashtext(p_market_id::text)
  );

  -- 3. Idempotency replay. If we already have a bet with this exact
  -- (user, market, key) triple, return its receipt and exit. This is the
  -- happy-path retry case (client dropped the response, resubmits).
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

  -- 4. If (user, key) is already used for a DIFFERENT market, reject — the
  -- UNIQUE index would raise 23505 at INSERT anyway; we raise the typed
  -- error now to keep the 4xx mapping clean.
  perform 1 from public.bets
    where user_id = p_user_id
      and idempotency_key = p_idempotency_key;
  if found then
    raise exception 'duplicate_idempotency_key' using errcode = 'H0003';
  end if;

  -- 5. Lock the market row and gate on status + closes_at. FOR UPDATE
  -- blocks a concurrent lock_due_markets() flipping status mid-flight.
  select * into v_market from public.markets
    where id = p_market_id for update;
  if not found then
    raise exception 'market_not_found' using errcode = 'H0008';
  end if;
  if v_market.status <> 'open' or v_market.closes_at <= now() then
    raise exception 'market_closed' using errcode = 'H0001';
  end if;

  -- 6. Resolve predicted_price → bin. NULL result means the price is
  -- outside [0, numeric_max), which in practice means negative or >= the
  -- tail-high sentinel (99999999.9999). Both rejected.
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

  -- 7. Rate limit: 10 bets/sec rolling window per user. Enforced inside
  -- the advisory-locked region so same-user burst can't race past it.
  -- count(*) returns bigint; cast to int for the comparison target type.
  select count(*)::int into v_rate_count
    from public.bets
   where user_id = p_user_id
     and placed_at > now() - interval '1 second';
  if v_rate_count >= 10 then
    raise exception 'rate_limited' using errcode = 'H0004';
  end if;

  -- 8. Per-market aggregate cap: $1000 per user per market.
  -- sum(bigint) returns numeric; cast back to bigint for comparison with
  -- p_stake_micro (the + must not overflow int8; aggregate ceiling is 1e9
  -- so we're nowhere near 2^63).
  select coalesce(sum(stake_micro), 0)::bigint into v_aggregate
    from public.bets
   where user_id = p_user_id
     and market_id = p_market_id;
  if v_aggregate + p_stake_micro > 1000000000 then
    raise exception 'exceeds_per_market_limit' using errcode = 'H0005';
  end if;

  -- 9. Balance check + lock user's wallet row. post_transfer's final
  -- min(balance) assertion is the hard guarantee; this pre-check surfaces
  -- a clean 402 before the ledger write.
  select balance_micro into v_balance
    from public.wallets
   where user_id = p_user_id
     and account = 'user_wallet'
     and currency = v_market.currency
   for update;
  if v_balance is null or v_balance < p_stake_micro then
    raise exception 'insufficient_balance' using errcode = 'H0002';
  end if;

  -- 10. Insert the bet. The UNIQUE(user_id, idempotency_key) constraint
  -- is the append-only gate; if any prior step missed a duplicate this
  -- catches it. 23505 → H0003.
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

  -- 11. Atomic ledger transfer: (-) user_wallet, (+) market_pool.
  -- post_transfer enforces SUM=0 + non-negative user balance.
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
    -- post_transfer's overdraft raise — remap so the edge function returns
    -- 402 insufficient_balance rather than a generic 500.
    if sqlerrm ilike '%negative%' then
      raise exception 'insufficient_balance' using errcode = 'H0002';
    end if;
    raise;
  end;

  -- 12. Increment the bin's cached stake + the market's pool total. Both
  -- are eventually consistent with SUM(bets.stake_micro); we cache them
  -- for sub-millisecond live-view reads in Phase 7.
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
  'Phase 4 hot-path entry point. Atomic bet placement: idempotency replay, '
  'status + closes_at gate, bin lookup, rate limit (10/s/user), aggregate '
  'cap ($1000/market/user), overdraft check, ledger transfer, bin + pool '
  'update. See 0004_bets.sql header for the SQLSTATE taxonomy.';

-- Service-role only — hot-path edge function calls via service key.
revoke execute on function public.place_bet(uuid, uuid, numeric, bigint, text)
  from public;
grant  execute on function public.place_bet(uuid, uuid, numeric, bigint, text)
  to service_role;
