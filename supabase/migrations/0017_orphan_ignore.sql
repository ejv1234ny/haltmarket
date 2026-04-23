-- =============================================================================
-- 0017_orphan_ignore.sql  --  "mark ignored" action for orphan deposits
--
-- Some orphans will never be claimed (wrong address type, test sends,
-- unknown parties). Admins can mark them resolved without binding to a
-- user, keeping the queue clean. Funds stay in the Safe hot wallet until
-- ops moves them manually.
-- =============================================================================

alter table public.crypto_orphan_deposits
  add column if not exists ignored_reason text;

create or replace function public.admin_ignore_orphan_deposit(
  p_orphan_id uuid,
  p_reason    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  if p_orphan_id is null then
    raise exception 'orphan_id required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'reason required' using errcode = '22023';
  end if;

  update public.crypto_orphan_deposits
     set resolved_at    = now(),
         ignored_reason = p_reason
   where id = p_orphan_id
     and resolved_at is null;
  if not found then
    raise exception 'orphan not found or already resolved' using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.admin_ignore_orphan_deposit(uuid, text) from public;
grant  execute on function public.admin_ignore_orphan_deposit(uuid, text) to authenticated;
