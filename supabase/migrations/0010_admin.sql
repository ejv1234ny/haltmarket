-- =============================================================================
-- 0010_admin.sql  --  Admin console primitives
--
-- Adds:
--   * user_profiles.is_admin flag (default false, ops-set only).
--   * set_system_flag(flag, value, note) SECURITY DEFINER — only admins may call.
--   * admin_mark_withdrawal_paid / admin_mark_withdrawal_failed wrappers that
--     check is_admin before delegating to the service-role RPCs from 0008.
--   * get_admin_withdrawal_queue() — admin-gated wrapper around the view.
--
-- All admin RPCs raise 42501 (insufficient_privilege) on non-admin callers.
-- =============================================================================

alter table public.user_profiles
  add column if not exists is_admin boolean not null default false;

create index if not exists user_profiles_is_admin_idx
  on public.user_profiles (is_admin) where is_admin;

-- -----------------------------------------------------------------------------
-- Internal gate. Wrap everywhere we need a SECURITY DEFINER admin check.
-- -----------------------------------------------------------------------------

create or replace function public.assert_is_admin()
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_is_admin boolean;
begin
  select is_admin into v_is_admin
    from public.user_profiles where user_id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'admin access required' using errcode = '42501';
  end if;
end;
$$;

grant execute on function public.assert_is_admin() to authenticated;

-- -----------------------------------------------------------------------------
-- set_system_flag: admin-callable freeze switch.
-- -----------------------------------------------------------------------------

create or replace function public.set_system_flag(
  p_flag text,
  p_value boolean,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  if p_flag is null or length(btrim(p_flag)) = 0 then
    raise exception 'flag required' using errcode = '22023';
  end if;
  update public.system_flags
     set value      = coalesce(p_value, false),
         note       = coalesce(p_note, note),
         updated_at = now(),
         updated_by = auth.uid()
   where flag = p_flag;
  if not found then
    raise exception 'unknown flag %', p_flag using errcode = '22023';
  end if;
end;
$$;

comment on function public.set_system_flag(text, boolean, text) is
  'Admin-gated toggle for system_flags rows. Admin check via assert_is_admin().';

revoke execute on function public.set_system_flag(text, boolean, text) from public;
grant  execute on function public.set_system_flag(text, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Admin-gated wrappers for withdrawal flow.
-- -----------------------------------------------------------------------------

create or replace function public.admin_mark_withdrawal_paid(
  p_withdrawal_id uuid,
  p_tx_hash       text,
  p_block_number  bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  perform public.mark_withdrawal_paid(p_withdrawal_id, p_tx_hash, p_block_number);
end;
$$;

revoke execute on function public.admin_mark_withdrawal_paid(uuid, text, bigint) from public;
grant  execute on function public.admin_mark_withdrawal_paid(uuid, text, bigint) to authenticated;

create or replace function public.admin_mark_withdrawal_failed(
  p_withdrawal_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  perform public.mark_withdrawal_failed(p_withdrawal_id, p_reason);
end;
$$;

revoke execute on function public.admin_mark_withdrawal_failed(uuid, text) from public;
grant  execute on function public.admin_mark_withdrawal_failed(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- get_admin_withdrawal_queue: admin-only read of the pending queue.
-- -----------------------------------------------------------------------------

create or replace function public.get_admin_withdrawal_queue()
returns table (
  id                   uuid,
  user_id              uuid,
  handle               text,
  amount_micro         bigint,
  destination_address  text,
  chain_id             integer,
  created_at           timestamptz,
  age_seconds          bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
begin
  perform public.assert_is_admin();
  return query
    select q.id, q.user_id, q.handle, q.amount_micro,
           q.destination_address, q.chain_id, q.created_at, q.age_seconds
      from public.admin_withdrawal_queue q;
end;
$$;

revoke execute on function public.get_admin_withdrawal_queue() from public;
grant  execute on function public.get_admin_withdrawal_queue() to authenticated;
