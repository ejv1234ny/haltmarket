-- scripts/ledger-integration-setup.sql
--
-- Provisions the minimal Supabase auth shim so supabase/migrations/0001_ledger.sql
-- applies cleanly to a bare Postgres 17. Used by scripts/ledger-integration.sh in
-- local dev and the `node` CI job.
--
-- Idempotent: safe to run multiple times against a throwaway DB.

create schema if not exists auth;

-- Mirrors the columns Supabase's real auth.users exposes that our migrations
-- reference: id, email, created_at, last_sign_in_at.
create table if not exists auth.users (
  id               uuid primary key,
  email            text,
  created_at       timestamptz not null default now(),
  last_sign_in_at  timestamptz
);

-- ALTER-if-exists guards for local dev runs where the table was created by
-- an older shim version. No-op in CI (table is fresh each run).
alter table auth.users add column if not exists email            text;
alter table auth.users add column if not exists created_at       timestamptz not null default now();
alter table auth.users add column if not exists last_sign_in_at  timestamptz;

-- auth.uid() — Supabase's real implementation reads from the PostgREST
-- JWT claim. Tests exercise admin RPCs via `set local request.jwt.claims`,
-- which this shim mirrors. Falls back to NULL when no JWT is set (the
-- service-role path used by seed scripts and non-RLS tests).
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

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
