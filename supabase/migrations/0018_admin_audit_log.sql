-- =============================================================================
-- 0018_admin_audit_log.sql  --  append-only audit trail for admin actions
--
-- Every admin_* RPC that mutates state now calls log_admin_action(...) as
-- its first step inside assert_is_admin. The log is:
--   * readable by admins
--   * append-only (UPDATE/DELETE blocked by trigger, mirroring the ledger
--     pattern from ADR-0001)
--   * keyed on (actor_user_id, action, created_at) so you can filter to one
--     admin or one action type without scanning the whole table
--
-- The action payload is a jsonb blob so each RPC can record whatever
-- context is useful (the target user id, tx hash, flag name, new value,
-- etc). Readers use a couple of documented keys:
--   target_user_id  — the user the action touched (if any)
--   target          — free-form identifier (orphan id, withdrawal id, flag)
--   changes         — before/after where useful
-- =============================================================================

create table if not exists public.admin_action_log (
  id              bigserial primary key,
  actor_user_id   uuid not null references auth.users(id) on delete restrict,
  action          text not null check (length(btrim(action)) > 0),
  target_user_id  uuid references auth.users(id),
  target          text,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists admin_action_log_created_at_idx
  on public.admin_action_log (created_at desc);
create index if not exists admin_action_log_actor_idx
  on public.admin_action_log (actor_user_id, created_at desc);
create index if not exists admin_action_log_action_idx
  on public.admin_action_log (action, created_at desc);
create index if not exists admin_action_log_target_user_idx
  on public.admin_action_log (target_user_id, created_at desc)
  where target_user_id is not null;

-- Append-only (matches the ledger_entries pattern).
create or replace function public.admin_action_log_deny_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'admin_action_log is append-only';
end;
$$;

create trigger admin_action_log_no_update
  before update on public.admin_action_log
  for each row execute function public.admin_action_log_deny_mutation();
create trigger admin_action_log_no_delete
  before delete on public.admin_action_log
  for each row execute function public.admin_action_log_deny_mutation();

alter table public.admin_action_log enable row level security;
-- No public policies — admin-only via SECURITY DEFINER reader below.

-- -----------------------------------------------------------------------------
-- log_admin_action — internal helper called by every admin_* wrapper. Uses
-- auth.uid() as the actor so callers don't need to pass it.
-- -----------------------------------------------------------------------------

create or replace function public.log_admin_action(
  p_action          text,
  p_target_user_id  uuid default null,
  p_target          text default null,
  p_payload         jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    -- Called from a service-role path without JWT — stamp as the system
    -- caller. Use a well-known zero-uuid convention so forensics can
    -- still filter. Skip FK check by NOT inserting an auth.users row; the
    -- FK allows NULL-referenced rows only via ON DELETE RESTRICT, so use
    -- the service-role case below.
    -- Simpler: require auth.uid() here and surface a clean error.
    raise exception 'log_admin_action called without auth.uid()'
      using errcode = '42501';
  end if;
  insert into public.admin_action_log (
    actor_user_id, action, target_user_id, target, payload
  ) values (
    v_actor, p_action, p_target_user_id, p_target, coalesce(p_payload, '{}'::jsonb)
  );
end;
$$;

revoke execute on function public.log_admin_action(text, uuid, text, jsonb) from public;
grant  execute on function public.log_admin_action(text, uuid, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- admin_get_action_log — paginated read for the /admin/audit page.
-- -----------------------------------------------------------------------------

create or replace function public.admin_get_action_log(
  p_limit  int default 100,
  p_offset int default 0
)
returns table (
  id              bigint,
  actor_user_id   uuid,
  actor_email     text,
  actor_handle    text,
  action          text,
  target_user_id  uuid,
  target          text,
  payload         jsonb,
  created_at      timestamptz
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
      l.id,
      l.actor_user_id,
      u.email::text,
      p.handle,
      l.action,
      l.target_user_id,
      l.target,
      l.payload,
      l.created_at
    from public.admin_action_log l
    left join auth.users u on u.id = l.actor_user_id
    left join public.user_profiles p on p.user_id = l.actor_user_id
    order by l.created_at desc
    limit greatest(p_limit, 1)
    offset greatest(p_offset, 0);
end;
$$;

revoke execute on function public.admin_get_action_log(int, int) from public;
grant  execute on function public.admin_get_action_log(int, int) to authenticated;

-- -----------------------------------------------------------------------------
-- Wrap the existing admin mutators to log each call. Each wrapper stays
-- the same signature (so the web + test surfaces don't change) and calls
-- log_admin_action after assert_is_admin but before delegating to the
-- concrete mutation.
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
declare
  v_prev boolean;
begin
  perform public.assert_is_admin();
  if p_flag is null or length(btrim(p_flag)) = 0 then
    raise exception 'flag required' using errcode = '22023';
  end if;
  select value into v_prev from public.system_flags where flag = p_flag;
  update public.system_flags
     set value      = coalesce(p_value, false),
         note       = coalesce(p_note, note),
         updated_at = now(),
         updated_by = auth.uid()
   where flag = p_flag;
  if not found then
    raise exception 'unknown flag %', p_flag using errcode = '22023';
  end if;
  perform public.log_admin_action(
    'set_system_flag',
    null,
    p_flag,
    jsonb_build_object('from', v_prev, 'to', p_value, 'note', p_note)
  );
end;
$$;

create or replace function public.admin_set_user_admin(
  p_user_id uuid,
  p_is_admin boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev boolean;
begin
  perform public.assert_is_admin();
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if p_user_id = auth.uid() and p_is_admin = false then
    raise exception 'admins cannot demote themselves; use the SQL editor'
      using errcode = '42501';
  end if;
  select is_admin into v_prev from public.user_profiles where user_id = p_user_id;
  insert into public.user_profiles (user_id, is_admin)
    values (p_user_id, p_is_admin)
  on conflict (user_id) do update
     set is_admin = excluded.is_admin,
         updated_at = now();
  perform public.log_admin_action(
    'admin_set_user_admin',
    p_user_id,
    null,
    jsonb_build_object('from', coalesce(v_prev, false), 'to', p_is_admin)
  );
end;
$$;

create or replace function public.admin_override_kyc(
  p_user_id uuid,
  p_status  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev text;
begin
  perform public.assert_is_admin();
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if p_status not in ('none', 'pending', 'approved', 'rejected') then
    raise exception 'status must be none|pending|approved|rejected'
      using errcode = '22023';
  end if;
  select kyc_status into v_prev from public.user_profiles where user_id = p_user_id;
  insert into public.user_profiles (user_id, kyc_status)
    values (p_user_id, p_status)
  on conflict (user_id) do update
     set kyc_status = excluded.kyc_status,
         updated_at = now();
  perform public.log_admin_action(
    'admin_override_kyc',
    p_user_id,
    null,
    jsonb_build_object('from', v_prev, 'to', p_status)
  );
end;
$$;

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
  perform public.log_admin_action(
    'admin_mark_withdrawal_paid',
    null,
    p_withdrawal_id::text,
    jsonb_build_object('tx_hash', p_tx_hash, 'block_number', p_block_number)
  );
end;
$$;

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
  perform public.log_admin_action(
    'admin_mark_withdrawal_failed',
    null,
    p_withdrawal_id::text,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

create or replace function public.admin_rescue_orphan_deposit(
  p_orphan_id uuid,
  p_user_id   uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orphan       public.crypto_orphan_deposits%rowtype;
  v_deposit_id   uuid;
begin
  perform public.assert_is_admin();
  if p_orphan_id is null or p_user_id is null then
    raise exception 'orphan_id and user_id required' using errcode = '22023';
  end if;

  select * into v_orphan
    from public.crypto_orphan_deposits
    where id = p_orphan_id
    for update;
  if not found then
    raise exception 'orphan not found' using errcode = '22023';
  end if;
  if v_orphan.resolved_at is not null then
    raise exception 'orphan already resolved' using errcode = '22023';
  end if;

  perform 1 from auth.users where id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = '22023';
  end if;

  insert into public.user_wallet_addresses (user_id, chain_id, address, source)
    values (p_user_id, v_orphan.chain_id, v_orphan.from_address, 'ops')
  on conflict (chain_id, address) do nothing;

  select public.credit_crypto_deposit(
    v_orphan.chain_id,
    v_orphan.tx_hash,
    v_orphan.from_address,
    v_orphan.to_address,
    v_orphan.amount_micro,
    v_orphan.block_number
  ) into v_deposit_id;

  update public.crypto_orphan_deposits
     set resolved_at = now(),
         resolved_deposit_id = v_deposit_id
   where id = p_orphan_id;

  perform public.log_admin_action(
    'admin_rescue_orphan_deposit',
    p_user_id,
    p_orphan_id::text,
    jsonb_build_object(
      'tx_hash', v_orphan.tx_hash,
      'amount_micro', v_orphan.amount_micro,
      'deposit_id', v_deposit_id
    )
  );

  return v_deposit_id;
end;
$$;

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
  perform public.log_admin_action(
    'admin_ignore_orphan_deposit',
    null,
    p_orphan_id::text,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;
