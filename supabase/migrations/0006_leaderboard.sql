-- =============================================================================
-- 0006_leaderboard.sql  --  30-day leaderboard RPC + user handles
--
-- Ships a SECURITY DEFINER `get_leaderboard(limit)` that aggregates public
-- leaderboard data (handle, total staked, net P&L, wins, total bets) without
-- exposing per-user bet rows — `bets` and `payouts` keep their owner-only RLS.
--
-- A minimal `user_profiles` table stores an optional handle. Users can set
-- their own handle (RLS owner-upsert); everyone can read handles (public).
-- Missing profile → handle defaults to an 8-char prefix of user id.
-- =============================================================================

create table if not exists public.user_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  handle      text unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

create policy user_profiles_select_public on public.user_profiles
  for select using (true);

create policy user_profiles_insert_own on public.user_profiles
  for insert with check (auth.uid() = user_id);

create policy user_profiles_update_own on public.user_profiles
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.get_leaderboard(p_limit int default 50)
returns table (
  user_id             uuid,
  handle              text,
  total_staked_micro  bigint,
  net_pnl_micro       bigint,
  wins                int,
  bets                int
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with recent_bets as (
    select b.user_id, b.id as bet_id, b.stake_micro
    from public.bets b
    where b.placed_at > now() - interval '30 days'
  ),
  recent_payouts as (
    select p.user_id, p.bet_id, sum(p.amount_micro)::bigint as payout_micro
    from public.payouts p
    join recent_bets rb on rb.bet_id = p.bet_id
    group by p.user_id, p.bet_id
  ),
  per_user as (
    select
      rb.user_id,
      coalesce(sum(rb.stake_micro), 0)::bigint                as total_staked_micro,
      coalesce(sum(rp.payout_micro), 0)::bigint               as total_payout_micro,
      count(*) filter (where rp.payout_micro > rb.stake_micro)::int as wins,
      count(*)::int                                           as bets_count
    from recent_bets rb
    left join recent_payouts rp on rp.bet_id = rb.bet_id and rp.user_id = rb.user_id
    group by rb.user_id
  )
  select
    pu.user_id,
    coalesce(up.handle, substr(pu.user_id::text, 1, 8)) as handle,
    pu.total_staked_micro,
    (pu.total_payout_micro - pu.total_staked_micro)::bigint as net_pnl_micro,
    pu.wins,
    pu.bets_count as bets
  from per_user pu
  left join public.user_profiles up on up.user_id = pu.user_id
  order by (pu.total_payout_micro - pu.total_staked_micro) desc, pu.total_staked_micro desc
  limit greatest(p_limit, 0);
$$;

comment on function public.get_leaderboard(int) is
  'Public 30-day leaderboard. Aggregates bets + payouts bypassing per-row RLS '
  '(SECURITY DEFINER). Only returns aggregate columns — no raw bet rows leak.';

revoke execute on function public.get_leaderboard(int) from public;
grant  execute on function public.get_leaderboard(int) to anon, authenticated, service_role;
