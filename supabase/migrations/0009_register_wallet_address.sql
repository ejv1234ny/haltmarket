-- =============================================================================
-- 0009_register_wallet_address.sql  --  Client-callable wallet-address registration
--
-- Phase 8 handoff §3: Privy provisions an embedded wallet per user on first
-- login. The client calls this RPC (via the /api/wallet-address route) to
-- persist the mapping. This is the one place a client writes into
-- user_wallet_addresses — everywhere else the write happens from service_role
-- (credit_crypto_deposit, reconciliation, admin tools).
--
-- SECURITY INVOKER on purpose: the RPC runs as the caller so `auth.uid()`
-- resolves to the signed-in user. RLS on user_wallet_addresses must allow
-- insert-own; the policy below is additive and mirrors the existing
-- `user_wallet_addresses_select_own` pattern.
-- =============================================================================

create policy user_wallet_addresses_insert_own on public.user_wallet_addresses
  for insert with check (auth.uid() = user_id);

create or replace function public.register_wallet_address(
  p_chain_id integer,
  p_address  text,
  p_source   text default 'privy'
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_chain_id is null or p_address is null then
    raise exception 'invalid arguments to register_wallet_address'
      using errcode = '22023';
  end if;
  if p_source not in ('privy', 'self') then
    -- 'ops' is a service-role-only source; clients may not self-declare as ops.
    raise exception 'invalid source' using errcode = '22023';
  end if;

  -- Idempotent on (chain_id, address). If the pair is already mapped to
  -- THIS user, return the existing id. If mapped to a different user, the
  -- unique constraint will raise — surface that as a clean error.
  select id into v_id
    from public.user_wallet_addresses
    where chain_id = p_chain_id and lower(address) = lower(p_address)
    limit 1;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.user_wallet_addresses (user_id, chain_id, address, source)
    values (v_user_id, p_chain_id, p_address, p_source)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.register_wallet_address(integer, text, text) is
  'Client-callable RPC. Maps a wallet address (e.g. Privy embedded wallet) '
  'to the signed-in user. Idempotent on (chain_id, address).';

revoke execute on function public.register_wallet_address(integer, text, text) from public;
grant  execute on function public.register_wallet_address(integer, text, text)
  to authenticated;
