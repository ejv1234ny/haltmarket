// Market + bin reads against Supabase. Backs /market/[id] and the landing
// feed. Components never call .from() directly — they go through these
// helpers so `supabaseConfigured === false` (local dev, CI Playwright)
// transparently falls back to fixtures.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase } from '../supabase/server';
import { supabaseConfigured } from '../env';
import {
  FIXTURE_MARKETS,
  RESOLVED_FIXTURE_MARKET,
  fixtureAllMarkets,
  fixtureMarketById,
} from './fixtures';
import type { Bin, Market } from './types';

interface MarketRow {
  id: string;
  halt_id: string;
  status: string;
  last_price: number | string;
  opened_at: string;
  closes_at: string;
  locked_at: string | null;
  resolved_at: string | null;
  refunded_at: string | null;
  currency: string;
  total_pool_micro: number | string;
  fee_bps: number;
  closest_bonus_bps: number;
  winning_bin_id: string | null;
}

interface HaltRow {
  id: string;
  symbol: string;
  reason_code: string;
  halt_kind: 'volatility' | 'news' | 'regulatory';
  halt_time: string;
  halt_end_time: string | null;
  reopen_price: number | string | null;
}

interface BinRow {
  id: string;
  market_id: string;
  idx: number;
  low_price: number | string;
  high_price: number | string;
  stake_micro: number | string;
}

interface ResolutionRow {
  market_id: string;
  reopen_price: number | string;
  winning_bin_id: string;
  closest_bonus_winner_user_id: string | null;
  closest_bonus_micro: number | string;
}

// Shared select shape so paged markets and single-market lookups agree.
// We join halts inline; bins + market_resolutions fetch in a second pass
// because supabase-js's nested select has gotcha cases with numeric casts.
const MARKET_COLUMNS = `
  id, halt_id, status, last_price, opened_at, closes_at, locked_at,
  resolved_at, refunded_at, currency, total_pool_micro, fee_bps,
  closest_bonus_bps, winning_bin_id
`;

function toBin(r: BinRow): Bin {
  return {
    id: r.id,
    market_id: r.market_id,
    idx: r.idx,
    low_price: Number(r.low_price),
    high_price: Number(r.high_price),
    stake_micro: Number(r.stake_micro),
  };
}

function hydrateMarket(
  row: MarketRow,
  halt: HaltRow,
  bins: Bin[],
  resolution: ResolutionRow | null,
): Market {
  const status = row.status as Market['status'];
  const reopenFromResolution = resolution ? Number(resolution.reopen_price) : null;
  const reopenFromHalt = halt.reopen_price !== null ? Number(halt.reopen_price) : null;
  return {
    id: row.id,
    halt_id: row.halt_id,
    symbol: halt.symbol,
    reason_code: halt.reason_code,
    halt_kind: halt.halt_kind,
    last_price: Number(row.last_price),
    halt_time: halt.halt_time,
    closes_at: row.closes_at,
    halt_end_time: halt.halt_end_time ?? row.closes_at,
    status,
    currency: row.currency as Market['currency'],
    total_pool_micro: Number(row.total_pool_micro),
    fee_bps: row.fee_bps,
    closest_bonus_bps: row.closest_bonus_bps,
    winning_bin_id: row.winning_bin_id ?? resolution?.winning_bin_id ?? null,
    reopen_price: reopenFromResolution ?? reopenFromHalt,
    closest_bonus_winner_user_id: resolution?.closest_bonus_winner_user_id ?? null,
    closest_bonus_amount_micro: resolution
      ? Number(resolution.closest_bonus_micro)
      : null,
    bins,
  };
}

async function fetchBinsByMarket(
  client: SupabaseClient,
  marketIds: readonly string[],
): Promise<Map<string, Bin[]>> {
  const map = new Map<string, Bin[]>();
  if (marketIds.length === 0) return map;
  const { data, error } = await client
    .from('bins')
    .select('id, market_id, idx, low_price, high_price, stake_micro')
    .in('market_id', marketIds)
    .order('idx');
  if (error) throw new Error(`bins query failed: ${error.message}`);
  for (const row of (data ?? []) as BinRow[]) {
    const arr = map.get(row.market_id) ?? [];
    arr.push(toBin(row));
    map.set(row.market_id, arr);
  }
  return map;
}

async function fetchResolutionsByMarket(
  client: SupabaseClient,
  marketIds: readonly string[],
): Promise<Map<string, ResolutionRow>> {
  const map = new Map<string, ResolutionRow>();
  if (marketIds.length === 0) return map;
  const { data, error } = await client
    .from('market_resolutions')
    .select(
      'market_id, reopen_price, winning_bin_id, closest_bonus_winner_user_id, closest_bonus_micro',
    )
    .in('market_id', marketIds);
  if (error) throw new Error(`market_resolutions query failed: ${error.message}`);
  for (const row of (data ?? []) as ResolutionRow[]) {
    map.set(row.market_id, row);
  }
  return map;
}

async function fetchHaltsByMarket(
  client: SupabaseClient,
  rows: readonly MarketRow[],
): Promise<Map<string, HaltRow>> {
  const haltIds = rows.map((r) => r.halt_id);
  const map = new Map<string, HaltRow>();
  if (haltIds.length === 0) return map;
  const { data, error } = await client
    .from('halts')
    .select('id, symbol, reason_code, halt_kind, halt_time, halt_end_time, reopen_price')
    .in('id', haltIds);
  if (error) throw new Error(`halts query failed: ${error.message}`);
  for (const h of (data ?? []) as HaltRow[]) map.set(h.id, h);
  return map;
}

/** Open + locked + recently-resolved markets for the home feed. */
export async function listAllMarkets(): Promise<Market[]> {
  if (!supabaseConfigured) return fixtureAllMarkets();
  const client = getServerSupabase();
  if (!client) return fixtureAllMarkets();

  const { data, error } = await client
    .from('markets')
    .select(MARKET_COLUMNS)
    .order('opened_at', { ascending: false })
    .limit(40);
  if (error) throw new Error(`markets query failed: ${error.message}`);

  const rows = (data ?? []) as MarketRow[];
  if (rows.length === 0) return [];

  const [halts, bins, resolutions] = await Promise.all([
    fetchHaltsByMarket(client, rows),
    fetchBinsByMarket(client, rows.map((r) => r.id)),
    fetchResolutionsByMarket(client, rows.map((r) => r.id)),
  ]);

  return rows
    .map((row) => {
      const halt = halts.get(row.halt_id);
      if (!halt) return null;
      return hydrateMarket(
        row,
        halt,
        bins.get(row.id) ?? [],
        resolutions.get(row.id) ?? null,
      );
    })
    .filter((m): m is Market => m !== null);
}

export async function getMarketById(id: string): Promise<Market | null> {
  if (!supabaseConfigured) return fixtureMarketById(id) ?? null;
  const client = getServerSupabase();
  if (!client) return fixtureMarketById(id) ?? null;

  const { data, error } = await client
    .from('markets')
    .select(MARKET_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`market query failed: ${error.message}`);
  if (!data) return null;

  const row = data as MarketRow;
  const [halts, bins, resolutions] = await Promise.all([
    fetchHaltsByMarket(client, [row]),
    fetchBinsByMarket(client, [row.id]),
    fetchResolutionsByMarket(client, [row.id]),
  ]);

  const halt = halts.get(row.halt_id);
  if (!halt) return null;
  return hydrateMarket(
    row,
    halt,
    bins.get(row.id) ?? [],
    resolutions.get(row.id) ?? null,
  );
}

// Re-exports so tests can exercise the fixture path explicitly.
export { FIXTURE_MARKETS, RESOLVED_FIXTURE_MARKET };
