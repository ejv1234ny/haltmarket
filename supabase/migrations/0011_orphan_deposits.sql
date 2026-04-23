-- =============================================================================
-- 0011_orphan_deposits.sql  --  Capture USDC sends from unmapped addresses
--
-- When a user sends USDC to the Safe hot wallet from an address we haven't
-- mapped yet (common: they withdrew from an exchange), credit_crypto_deposit
-- raises H0014 and nothing is recorded. The deposit-watcher now calls
-- record_orphan_deposit on H0014 so ops has a queue to triage.
--
-- Admin resolves an orphan via admin_rescue_orphan_deposit: the admin supplies
-- the user_id, the RPC inserts the address mapping and re-runs
-- credit_crypto_deposit, then marks the orphan resolved.
-- =============================================================================

create table if not exists public.crypto_orphan_deposits (
  id                   uuid primary key default gen_random_uuid(),
  chain_id             integer not null,
  tx_hash              text not null,
  from_address         text not null check (from_address ~ '^0x[a-fA-F0-9]{40}$'),
  to_address           text,
  amount_micro         bigint not null check (amount_micro > 0),
  block_number         bigint,
  detected_at          timestamptz not null default now(),
  resolved_at          timestamptz,
  resolved_deposit_id  uuid references public.deposits(id),
  unique (chain_id, tx_hash)
);

create index if not exists crypto_orphan_deposits_unresolved_idx
  on public.crypto_orphan_deposits (detected_at desc)
  where resolved_at is null;

alter table public.crypto_orphan_deposits enable row level security;
-- No public policies — admin-only via SECURITY DEFINER RPCs below.

-- -----------------------------------------------------------------------------
-- record_orphan_deposit: called by the deposit-watcher on H0014 from
-- credit_crypto_deposit. Idempotent on (chain_id, tx_hash).
-- -----------------------------------------------------------------------------

create or replace function public.record_orphan_deposit(
  p_chain_id      integer,
  p_tx_hash       text,
  p_from_address  text,
  p_to_address    text,
  p_amount_micro  bigint,
  p_block_number  bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_chain_id is null or p_tx_hash is null or p_from_address is null
     or p_amount_micro is null or p_amount_micro <= 0 then
    raise exception 'invalid arguments to record_orphan_deposit'
      using errcode = '22023';
  end if;

  -- If we already recorded this orphan, return the existing id.
  select id into v_id
    from public.crypto_orphan_deposits
    where chain_id = p_chain_id and tx_hash = p_tx_hash
    limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.crypto_orphan_deposits (
    chain_id, tx_hash, from_address, to_address, amount_micro, block_number
  ) values (
    p_chain_id, p_tx_hash, p_from_address, p_to_address, p_amount_micro, p_block_number
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.record_orphan_deposit(integer, text, text, text, bigint, bigint)
  from public;
grant  execute on function public.record_orphan_deposit(integer, text, text, text, bigint, bigint)
  to service_role;

-- -----------------------------------------------------------------------------
-- admin_get_orphan_deposits: admin-gated list of unresolved orphans.
-- -----------------------------------------------------------------------------

create or replace function public.admin_get_orphan_deposits()
returns table (
  id            uuid,
  chain_id      integer,
  tx_hash       text,
  from_address  text,
  amount_micro  bigint,
  block_number  bigint,
  detected_at   timestamptz,
  age_seconds   bigint
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  perform public.assert_is_admin();
  return query
    select o.id, o.chain_id, o.tx_hash, o.from_address, o.amount_micro,
           o.block_number, o.detected_at,
           extract(epoch from (now() - o.detected_at))::bigint as age_seconds
      from public.crypto_orphan_deposits o
     where o.resolved_at is null
     order by o.detected_at asc;
end;
$$;

revoke execute on function public.admin_get_orphan_deposits() from public;
grant  execute on function public.admin_get_orphan_deposits() to authenticated;

-- -----------------------------------------------------------------------------
-- admin_rescue_orphan_deposit: admin binds the orphan's sender address to a
-- user, then credits the deposit. Single transaction so either the full
-- rescue lands or nothing does.
-- -----------------------------------------------------------------------------

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

  -- Make sure the target user exists.
  perform 1 from auth.users where id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = '22023';
  end if;

  -- Bind sender address → user_id (idempotent on the unique (chain_id, address)
  -- index). 'ops' source flag marks this as admin-created.
  insert into public.user_wallet_addresses (user_id, chain_id, address, source)
    values (p_user_id, v_orphan.chain_id, v_orphan.from_address, 'ops')
  on conflict (chain_id, address) do nothing;

  -- Re-run the credit path now that the mapping exists.
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

  return v_deposit_id;
end;
$$;

revoke execute on function public.admin_rescue_orphan_deposit(uuid, uuid) from public;
grant  execute on function public.admin_rescue_orphan_deposit(uuid, uuid) to authenticated;
