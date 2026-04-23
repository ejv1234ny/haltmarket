-- =============================================================================
-- 0012_realtime_wallets.sql  --  Realtime channel for user wallet balance
--
-- Adds public.wallets to the supabase_realtime publication so the frontend
-- can subscribe to postgres_changes events for the signed-in user's wallet.
-- RLS on wallets (wallets_select_own) is respected by Supabase Realtime,
-- so subscribers only receive events for rows they're allowed to SELECT.
-- =============================================================================

-- The publication is created automatically by Supabase projects. Create it
-- defensively here so the migration is applicable to bare Postgres (CI).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- ALTER PUBLICATION ADD TABLE is not idempotent on its own; guard with a
-- lookup in pg_publication_rel.
do $$
begin
  if not exists (
    select 1
      from pg_publication_rel pr
      join pg_publication p on p.oid = pr.prpubid
     where p.pubname = 'supabase_realtime'
       and pr.prrelid = 'public.wallets'::regclass
  ) then
    alter publication supabase_realtime add table public.wallets;
  end if;
end $$;
