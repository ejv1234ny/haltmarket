-- scripts/ledger-integration-setup.sql
--
-- Provisions the minimal Supabase auth shim so supabase/migrations/0001_ledger.sql
-- applies cleanly to a bare Postgres 17. Used by scripts/ledger-integration.sh in
-- local dev and the `node` CI job.
--
-- Idempotent: safe to run multiple times against a throwaway DB.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

-- auth.uid() — Supabase-provided in prod. Tests don't assume a logged-in user,
-- so a stub that returns NULL is sufficient for RLS policies that reference it.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$ select null::uuid $$;

do $$ begin
  create role authenticated;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role anon;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role service_role bypassrls;
exception when duplicate_object then null;
end $$;
