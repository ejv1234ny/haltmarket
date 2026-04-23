-- =============================================================================
-- 0014_push_subscriptions.sql  --  Web Push subscription registry
--
-- Stores one row per browser that opted into push notifications. The
-- notify-halt edge function fans out to every row on new markets.
--
-- Ownership model: a user may have many subscriptions (multiple devices).
-- The unique endpoint string is the de-dupe key — a browser that re-
-- subscribes returns the same endpoint, so ON CONFLICT DO UPDATE refreshes
-- the row in place.
-- =============================================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  unique (endpoint)
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy push_subscriptions_select_own on public.push_subscriptions
  for select using (auth.uid() = user_id);

create policy push_subscriptions_insert_own on public.push_subscriptions
  for insert with check (auth.uid() = user_id);

create policy push_subscriptions_delete_own on public.push_subscriptions
  for delete using (auth.uid() = user_id);

comment on table public.push_subscriptions is
  'Web Push subscription registry. One row per browser. notify-halt edge '
  'function fans out to every active row when a market opens.';
