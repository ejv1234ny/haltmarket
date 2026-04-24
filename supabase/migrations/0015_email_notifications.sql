-- =============================================================================
-- 0015_email_notifications.sql  --  opt-in email notifications for halts
--
-- Adds a per-user notify_email_on_halt flag. The notify-halt edge function
-- fans out to every user with flag=true, via Resend. Opt-in only so the
-- default behavior stays quiet for users who only want the web push path.
-- =============================================================================

alter table public.user_profiles
  add column if not exists notify_email_on_halt boolean not null default false;

create index if not exists user_profiles_email_notify_idx
  on public.user_profiles (user_id) where notify_email_on_halt;

-- -----------------------------------------------------------------------------
-- get_email_notify_targets: admin-independent read used by notify-halt. Joins
-- auth.users to fetch email. SECURITY DEFINER because auth.users isn't
-- readable via client JWT; the edge function calls this via service_role
-- regardless, so SECURITY DEFINER is fine for symmetry with other notify
-- helpers.
-- -----------------------------------------------------------------------------

create or replace function public.get_email_notify_targets()
returns table (user_id uuid, email text)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select p.user_id, u.email::text
    from public.user_profiles p
    join auth.users u on u.id = p.user_id
   where p.notify_email_on_halt = true
     and u.email is not null;
$$;

revoke execute on function public.get_email_notify_targets() from public;
grant  execute on function public.get_email_notify_targets() to service_role;
