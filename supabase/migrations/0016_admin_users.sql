-- =============================================================================
-- 0016_admin_users.sql  --  admin-gated user management RPCs
--
-- Admins can grant/revoke admin + override KYC status without dropping into
-- the SQL editor. These are thin wrappers around user_profiles updates, all
-- gated on assert_is_admin().
-- =============================================================================

create or replace function public.admin_list_users(
  p_limit int default 200,
  p_query text default null
)
returns table (
  user_id     uuid,
  email       text,
  handle      text,
  kyc_status  text,
  geo_country char(2),
  is_admin    boolean,
  notify_email_on_halt boolean,
  created_at  timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  return query
    select
      u.id,
      u.email::text,
      p.handle,
      p.kyc_status,
      p.geo_country,
      coalesce(p.is_admin, false),
      coalesce(p.notify_email_on_halt, false),
      u.created_at,
      u.last_sign_in_at
    from auth.users u
    left join public.user_profiles p on p.user_id = u.id
    where p_query is null
       or u.email ilike '%' || p_query || '%'
       or p.handle ilike '%' || p_query || '%'
    order by u.created_at desc
    limit greatest(p_limit, 1);
end;
$$;

revoke execute on function public.admin_list_users(int, text) from public;
grant  execute on function public.admin_list_users(int, text) to authenticated;

-- -----------------------------------------------------------------------------
-- admin_set_user_admin: toggle is_admin for a target user. Guardrail:
-- admins cannot demote themselves (prevents accidental lock-out of the last
-- admin — ops must edit the DB directly for that).
-- -----------------------------------------------------------------------------

create or replace function public.admin_set_user_admin(
  p_user_id uuid,
  p_is_admin boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if p_user_id = auth.uid() and p_is_admin = false then
    raise exception 'admins cannot demote themselves; use the SQL editor'
      using errcode = '42501';
  end if;

  insert into public.user_profiles (user_id, is_admin)
    values (p_user_id, p_is_admin)
  on conflict (user_id) do update
     set is_admin = excluded.is_admin,
         updated_at = now();
end;
$$;

revoke execute on function public.admin_set_user_admin(uuid, boolean) from public;
grant  execute on function public.admin_set_user_admin(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- admin_override_kyc: manual KYC status set by an admin. Useful for internal
-- beta accounts before a vendor is wired, or to flip an already-verified
-- user to 'rejected' in response to a compliance incident.
-- -----------------------------------------------------------------------------

create or replace function public.admin_override_kyc(
  p_user_id uuid,
  p_status  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if p_status not in ('none', 'pending', 'approved', 'rejected') then
    raise exception 'status must be none|pending|approved|rejected'
      using errcode = '22023';
  end if;

  insert into public.user_profiles (user_id, kyc_status)
    values (p_user_id, p_status)
  on conflict (user_id) do update
     set kyc_status = excluded.kyc_status,
         updated_at = now();
end;
$$;

revoke execute on function public.admin_override_kyc(uuid, text) from public;
grant  execute on function public.admin_override_kyc(uuid, text) to authenticated;
