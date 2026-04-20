-- =============================================================================
-- 0004_place_bet.sql  --  Phase 4: atomic bet placement
--
-- Adds:
--   * bet_rate_limits  — 1-second tumbling-window per-user rate counters
--   * place_bet()      — SERIALIZABLE SECURITY DEFINER RPC that enforces every
--                        invariant inside one atomic transaction
--
-- Invariants enforced:
--   market open + closes_at check · rate limit (10/sec per user) ·
--   idempotency (per user+key) · sufficient wallet balance ·
--   $1 000 aggregate per-market cap · bin derivation via find_bin_for_price ·
--   ledger transfer (calls post_transfer) · bets insert ·
--   bins.stake_micro + markets.total_pool_micro increments
--
-- Error messages raised map to HTTP status codes in the edge function:
--   market_not_found         → 404
--   market_closed            → 409
--   price_outside_ladder     → 400
--   insufficient_balance     → 402
--   duplicate_idempotency_key → 409   (return existing receipt — idempotent)
--   rate_limited             → 429
--   exceeds_per_market_limit → 409
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bet_rate_limits: 1-second tumbling-window counters per user.
-- Cleaned lazily (per-user, 10-second TTL) inside place_bet on each call.
-- No direct-write RLS policies — only SECURITY DEFINER RPCs access this table.
-- -----------------------------------------------------------------------------

create table public.bet_rate_limits (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  count        integer     not null default 1 check (count > 0),
  primary key  (user_id, window_start)
);

alter table public.bet_rate_limits enable row level security;

create index bet_rate_limits_user_window_idx
  on public.bet_rate_limits (user_id, window_start);

comment on table public.bet_rate_limits is
  'Per-user 1-second rate-limit counters. Cleaned lazily in place_bet(). '
  'Primary key ensures only one row per (user, second); count incremented via upsert.';

-- -----------------------------------------------------------------------------
-- place_bet: full atomic bet placement.
--
-- Returns jsonb:
--   { idempotent bool, bet_id uuid, bin_id uuid,
--     new_bin_stake_micro text, new_total_pool_micro text }
--
-- p_txn_id is caller-generated so the edge function can persist it for at-most-
-- once semantics before calling this RPC (matches ADR-0001 §Decision).
--
-- SET default_transaction_isolation = serializable causes PostgREST to open a
-- SERIALIZABLE transaction for each RPC call, preventing phantom reads on the
-- wallet balance and idempotency checks. post_transfer's row-level balance check
-- provides a second safety net against overdraft.
-- -----------------------------------------------------------------------------

create or replace function public.place_bet(
  p_user_id         uuid,
  p_market_id       uuid,
  p_predicted_price numeric(12,4),
  p_stake_micro     bigint,
  p_idempotency_key text,
  p_txn_id          uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path                    = public, pg_temp
  set default_transaction_isolation to 'serializable'
as $$
declare
  v_market          record;
  v_wallet_balance  bigint;
  v_bin_id          uuid;
  v_bet_id          uuid;
  v_rate_count      integer;
  v_user_mkt_stake  bigint;
  v_new_bin_stake   bigint;
  v_new_pool_micro  bigint;
  v_existing        record;
begin
  if p_stake_micro <= 0 then
    raise exception 'invalid_stake' using errcode = 'P0001';
  end if;

  -- ── Rate limit: 10 bets/sec per user (1-second tumbling window) ──────────
  -- Purge stale windows for this user (10-second TTL keeps the table lean).
  delete from public.bet_rate_limits
   where user_id = p_user_id
     and window_start < now() - interval '10 seconds';

  insert into public.bet_rate_limits (user_id, window_start, count)
  values (p_user_id, date_trunc('second', now()), 1)
  on conflict (user_id, window_start) do update
    set count = bet_rate_limits.count + 1
  returning count into v_rate_count;

  if v_rate_count > 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- ── Idempotency: return existing receipt when key already used ────────────
  select id, bin_id, market_id
    into v_existing
    from public.bets
   where user_id          = p_user_id
     and idempotency_key  = p_idempotency_key;

  if found then
    -- Same key for a different market is a real conflict.
    if v_existing.market_id <> p_market_id then
      raise exception 'duplicate_idempotency_key' using errcode = 'P0001';
    end if;
    -- Same market → idempotent success; return existing receipt unchanged.
    select stake_micro      into v_new_bin_stake  from public.bins    where id = v_existing.bin_id;
    select total_pool_micro into v_new_pool_micro from public.markets where id = p_market_id;
    return jsonb_build_object(
      'idempotent',           true,
      'bet_id',               v_existing.id,
      'bin_id',               v_existing.bin_id,
      'new_bin_stake_micro',  v_new_bin_stake,
      'new_total_pool_micro', v_new_pool_micro
    );
  end if;

  -- ── Market assertions ─────────────────────────────────────────────────────
  select * into v_market
    from public.markets
   where id = p_market_id
   for update;

  if not found then
    raise exception 'market_not_found' using errcode = 'P0001';
  end if;
  if v_market.status <> 'open' or now() >= v_market.closes_at then
    raise exception 'market_closed' using errcode = 'P0001';
  end if;

  -- ── Bin derivation (server-side; NULL ⟹ price outside ladder) ────────────
  v_bin_id := public.find_bin_for_price(p_market_id, p_predicted_price);
  if v_bin_id is null then
    raise exception 'price_outside_ladder' using errcode = 'P0001';
  end if;

  -- ── Balance check ─────────────────────────────────────────────────────────
  select balance_micro into v_wallet_balance
    from public.wallets
   where user_id = p_user_id
     and account = 'user_wallet'
   for update;

  if v_wallet_balance is null or v_wallet_balance < p_stake_micro then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;

  -- ── Per-market aggregate stake cap: $1 000 = 1_000_000_000 micro ─────────
  select coalesce(sum(stake_micro), 0) into v_user_mkt_stake
    from public.bets
   where user_id    = p_user_id
     and market_id  = p_market_id
     and status     = 'active';

  if v_user_mkt_stake + p_stake_micro > 1000000000 then
    raise exception 'exceeds_per_market_limit' using errcode = 'P0001';
  end if;

  -- ── Ledger transfer: (−) user_wallet → (+) market_pool ───────────────────
  perform public.post_transfer(
    p_txn_id,
    jsonb_build_array(
      jsonb_build_object(
        'user_id',       p_user_id,
        'account',       'user_wallet',
        'currency',      'USDC',
        'amount_micro',  (-p_stake_micro)::text,
        'ref_market_id', p_market_id
      ),
      jsonb_build_object(
        'account',       'market_pool',
        'currency',      'USDC',
        'amount_micro',  p_stake_micro::text,
        'ref_market_id', p_market_id
      )
    ),
    'bet_placed'
  );

  -- ── Insert bet row ────────────────────────────────────────────────────────
  v_bet_id := gen_random_uuid();
  insert into public.bets
    (id, market_id, bin_id, user_id, stake_micro, predicted_price, idempotency_key)
  values
    (v_bet_id, p_market_id, v_bin_id, p_user_id,
     p_stake_micro, p_predicted_price, p_idempotency_key);

  -- ── Update counters ───────────────────────────────────────────────────────
  update public.bins
     set stake_micro = stake_micro + p_stake_micro
   where id = v_bin_id
  returning stake_micro into v_new_bin_stake;

  update public.markets
     set total_pool_micro = total_pool_micro + p_stake_micro
   where id = p_market_id
  returning total_pool_micro into v_new_pool_micro;

  return jsonb_build_object(
    'idempotent',           false,
    'bet_id',               v_bet_id,
    'bin_id',               v_bin_id,
    'new_bin_stake_micro',  v_new_bin_stake,
    'new_total_pool_micro', v_new_pool_micro
  );
end;
$$;

comment on function public.place_bet(uuid, uuid, numeric, bigint, text, uuid) is
  'Atomic bet placement. Enforces: market open, rate limit (10/sec), idempotency, '
  'wallet balance, $1000 per-market cap. Calls post_transfer, inserts bets row, '
  'increments bins.stake_micro + markets.total_pool_micro. SERIALIZABLE isolation.';

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke execute on function public.place_bet(uuid, uuid, numeric, bigint, text, uuid)
  from public;
grant  execute on function public.place_bet(uuid, uuid, numeric, bigint, text, uuid)
  to service_role;
