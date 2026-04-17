-- =============================================================================
-- 0002_halts.sql  --  Phase 2: halt ingestion schema
--
-- Stores every NASDAQ trade halt the monitor sees. Scope per AGENTS.md §Phase 2
-- (amended by ADR-0002): LUDP (volatility), T1 + T12 (news), H10 (regulatory).
-- The halt_kind column is a stored generated classification so downstream phases
-- can filter "hot vs boring" halts without re-parsing RSS reason codes.
--
-- Dedup relies on a UNIQUE (symbol, halt_time, reason_code) constraint; the
-- monitor calls insert_halt(...) with ON CONFLICT DO NOTHING semantics so a
-- reposted RSS item is a cheap no-op.
--
-- Phase 3+ will add `markets.halt_id references halts(id)`. This migration is
-- additive only (AGENTS.md §5.4) — no ALTER on prior objects.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.halt_reason_code as enum ('LUDP', 'T1', 'T12', 'H10');

create type public.halt_kind as enum ('volatility', 'news', 'regulatory');

-- Immutable classifier used by a generated column below. Must be IMMUTABLE so
-- Postgres accepts it in `generated always as ... stored`.
create or replace function public.halt_kind_for_reason(p_code public.halt_reason_code)
returns public.halt_kind
language sql
immutable
parallel safe
as $$
  select case p_code
    when 'LUDP' then 'volatility'::public.halt_kind
    when 'T1'   then 'news'::public.halt_kind
    when 'T12'  then 'news'::public.halt_kind
    when 'H10'  then 'regulatory'::public.halt_kind
  end;
$$;

comment on function public.halt_kind_for_reason(public.halt_reason_code) is
  'Maps Nasdaq reason code → halt_kind. Immutable so halts.halt_kind can be a '
  'stored generated column. Extending reason codes requires a new enum value '
  'and a new branch here.';

-- -----------------------------------------------------------------------------
-- halts: one row per detected halt. Reopen columns populated by Phase 5.
-- -----------------------------------------------------------------------------

create table public.halts (
  id              uuid primary key default gen_random_uuid(),
  symbol          text not null check (length(btrim(symbol)) > 0),
  reason_code     public.halt_reason_code not null,
  halt_kind       public.halt_kind not null
                  generated always as (public.halt_kind_for_reason(reason_code)) stored,
  halt_time       timestamptz not null,
  halt_end_time   timestamptz,
  last_price      numeric(12,4),
  reopen_price    numeric(12,4),
  reopen_at       timestamptz,
  reopen_source   text,
  received_at     timestamptz not null default now(),
  constraint halts_dedup unique (symbol, halt_time, reason_code)
);

create index halts_halt_time_idx on public.halts (halt_time desc);
create index halts_symbol_halt_time_idx on public.halts (symbol, halt_time desc);
create index halts_kind_halt_time_idx on public.halts (halt_kind, halt_time desc);
create index halts_unresolved_idx on public.halts (halt_time desc)
  where reopen_price is null;

comment on table public.halts is
  'Detected Nasdaq trade halts. Monitor inserts via insert_halt(); resolver '
  'updates reopen_price / reopen_at / reopen_source in Phase 5. halt_kind is a '
  'stored generated column driven by reason_code.';

-- -----------------------------------------------------------------------------
-- RLS: halts are a public facts table (every user can see any market's halt);
-- writes are service-role only via SECURITY DEFINER RPCs below.
-- -----------------------------------------------------------------------------

alter table public.halts enable row level security;

create policy halts_select_all
  on public.halts
  for select
  using (true);

-- No insert/update/delete policies → anon + authenticated roles cannot write.
-- service_role bypasses RLS; that's the only channel for monitor writes.

-- -----------------------------------------------------------------------------
-- insert_halt(...): idempotent insert keyed on (symbol, halt_time, reason_code).
-- Returns the row id on new insert, or NULL when the halt was already recorded.
-- -----------------------------------------------------------------------------

create or replace function public.insert_halt(
  p_symbol        text,
  p_reason_code   public.halt_reason_code,
  p_halt_time     timestamptz,
  p_halt_end_time timestamptz default null,
  p_last_price    numeric(12,4) default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_symbol is null or length(btrim(p_symbol)) = 0 then
    raise exception 'symbol is required' using errcode = '22004';
  end if;
  if p_reason_code is null then
    raise exception 'reason_code is required' using errcode = '22004';
  end if;
  if p_halt_time is null then
    raise exception 'halt_time is required' using errcode = '22004';
  end if;
  if p_last_price is not null and p_last_price <= 0 then
    raise exception 'last_price must be positive when provided'
      using errcode = '22023';
  end if;

  insert into public.halts
    (symbol, reason_code, halt_time, halt_end_time, last_price)
  values
    (btrim(p_symbol), p_reason_code, p_halt_time, p_halt_end_time, p_last_price)
  on conflict on constraint halts_dedup do nothing
  returning id into v_id;

  return v_id; -- NULL when the halt already existed (caller treats as no-op)
end;
$$;

comment on function public.insert_halt(
  text, public.halt_reason_code, timestamptz, timestamptz, numeric
) is
  'Idempotent halt insert. Returns new id on insert; NULL on dedup hit. Monitor '
  'calls this on every RSS item so re-posted items are no-ops.';

-- -----------------------------------------------------------------------------
-- record_reopen(...): Phase 5 resolver target. Defined here so the signature is
-- fixed early; no-op if called twice (idempotent via equality check).
-- -----------------------------------------------------------------------------

create or replace function public.record_reopen(
  p_halt_id       uuid,
  p_reopen_price  numeric(12,4),
  p_reopen_at     timestamptz,
  p_reopen_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_halt_id is null then
    raise exception 'halt_id is required' using errcode = '22004';
  end if;
  if p_reopen_price is null or p_reopen_price <= 0 then
    raise exception 'reopen_price must be positive' using errcode = '22023';
  end if;
  if p_reopen_at is null then
    raise exception 'reopen_at is required' using errcode = '22004';
  end if;
  if p_reopen_source is null or length(btrim(p_reopen_source)) = 0 then
    raise exception 'reopen_source is required' using errcode = '22004';
  end if;

  update public.halts
     set reopen_price  = p_reopen_price,
         reopen_at     = p_reopen_at,
         reopen_source = p_reopen_source
   where id = p_halt_id
     and reopen_price is null;
end;
$$;

comment on function public.record_reopen(uuid, numeric, timestamptz, text) is
  'Resolver updates reopen data exactly once per halt. Subsequent calls are '
  'no-ops because the WHERE clause requires reopen_price IS NULL.';

-- -----------------------------------------------------------------------------
-- Grants: only service_role can call insert_halt / record_reopen. The anon and
-- authenticated roles never touch halts directly; they read via RLS SELECT.
-- -----------------------------------------------------------------------------

revoke all on function public.insert_halt(
  text, public.halt_reason_code, timestamptz, timestamptz, numeric
) from public;
grant execute on function public.insert_halt(
  text, public.halt_reason_code, timestamptz, timestamptz, numeric
) to service_role;

revoke all on function public.record_reopen(uuid, numeric, timestamptz, text)
  from public;
grant execute on function public.record_reopen(uuid, numeric, timestamptz, text)
  to service_role;
