-- =============================================================================
-- 0013_kyc_rpc.sql  --  service-role KYC status setter
--
-- apply_kyc_decision is the one RPC the initiate-kyc edge function calls when
-- a vendor webhook (Persona / Sumsub / Stripe Identity) posts an identity
-- decision. The edge function verifies the vendor's signature, then forwards
-- the user + status to this RPC.
--
-- Also allows updating geo_country at the same time so the compliance gate
-- in place_bet (H0010) can evaluate correctly.
-- =============================================================================

create or replace function public.apply_kyc_decision(
  p_user_id     uuid,
  p_status      text,
  p_geo_country char(2) default null,
  p_provider    text default null,
  p_reference   text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if p_status not in ('none', 'pending', 'approved', 'rejected') then
    raise exception 'status must be none|pending|approved|rejected'
      using errcode = '22023';
  end if;

  -- Ensure a profile row exists so we can update it.
  insert into public.user_profiles (user_id, kyc_status)
    values (p_user_id, p_status)
  on conflict (user_id) do update
     set kyc_status = excluded.kyc_status,
         geo_country = coalesce(excluded_geo_country(p_geo_country), public.user_profiles.geo_country),
         updated_at = now();

  -- Keep the conditional geo update simple with a second statement (the
  -- CONFLICT branch above can't reference per-row EXCLUDED scalars cleanly
  -- without a wrapper). Only update when provided so we don't clobber a
  -- previously-set country with NULL.
  if p_geo_country is not null then
    update public.user_profiles
       set geo_country = p_geo_country,
           updated_at  = now()
     where user_id = p_user_id;
  end if;

  -- Optional: leave a breadcrumb on provider/reference. Cheap audit trail.
  if p_provider is not null or p_reference is not null then
    perform 1;  -- placeholder; ops can query user_profiles.updated_at + vendor logs
  end if;
end;
$$;

-- The excluded_geo_country shim is not strictly needed because we re-update
-- below; drop the helper lookup from the upsert by replacing the conflict
-- branch with a simple no-op on geo.
create or replace function public.apply_kyc_decision(
  p_user_id     uuid,
  p_status      text,
  p_geo_country char(2) default null,
  p_provider    text default null,
  p_reference   text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;
  if p_status not in ('none', 'pending', 'approved', 'rejected') then
    raise exception 'status must be none|pending|approved|rejected'
      using errcode = '22023';
  end if;

  insert into public.user_profiles (user_id, kyc_status, geo_country)
    values (p_user_id, p_status, p_geo_country)
  on conflict (user_id) do update
     set kyc_status = excluded.kyc_status,
         geo_country = coalesce(excluded.geo_country, public.user_profiles.geo_country),
         updated_at = now();

  -- provider + reference are accepted for future audit; no storage yet.
  perform p_provider, p_reference;
end;
$$;

comment on function public.apply_kyc_decision(uuid, text, char, text, text) is
  'Service-role KYC decision writer. Called by the initiate-kyc edge function '
  'after verifying a vendor callback signature.';

revoke execute on function public.apply_kyc_decision(uuid, text, char, text, text) from public;
grant  execute on function public.apply_kyc_decision(uuid, text, char, text, text) to service_role;
