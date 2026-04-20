// Server-side reads for a user's bets + their payouts. The client-side
// call to the Phase 4 place-bet edge function lives in ./place-bet.ts —
// kept separate so pulling `supabase/server` into the server bundle
// doesn't taint the client.

import { getServerSupabase } from '../supabase/server';
import { supabaseConfigured } from '../env';
import { FIXTURE_BETS, FIXTURE_PAYOUTS } from './fixtures';
import type { Bet, Payout } from './types';

interface BetRow {
  id: string;
  market_id: string;
  bin_id: string;
  user_id: string;
  predicted_price: number | string;
  stake_micro: number | string;
  placed_at: string;
  status: string;
}

interface PayoutRow {
  bet_id: string;
  market_id: string;
  source: 'bin' | 'closest_bonus' | 'refund';
  amount_micro: number | string;
  created_at: string;
}

export async function listBetsForUser(userId: string): Promise<Bet[]> {
  if (!supabaseConfigured) {
    return FIXTURE_BETS.filter((b) => b.user_id === userId);
  }
  const client = getServerSupabase();
  if (!client) return FIXTURE_BETS.filter((b) => b.user_id === userId);

  const { data, error } = await client
    .from('bets')
    .select('id, market_id, bin_id, user_id, predicted_price, stake_micro, placed_at, status')
    .eq('user_id', userId)
    .order('placed_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`bets query failed: ${error.message}`);

  const rows = (data ?? []) as BetRow[];
  if (rows.length === 0) return [];

  // Resolve each bet's market symbol in one round-trip rather than N+1.
  const marketIds = Array.from(new Set(rows.map((r) => r.market_id)));
  const { data: mkts, error: mkErr } = await client
    .from('markets')
    .select('id, halt_id')
    .in('id', marketIds);
  if (mkErr) throw new Error(`markets lookup failed: ${mkErr.message}`);
  const mktRows = (mkts ?? []) as { id: string; halt_id: string }[];
  const haltIds = mktRows.map((m) => m.halt_id);
  const { data: halts, error: haltErr } = await client
    .from('halts')
    .select('id, symbol')
    .in('id', haltIds);
  if (haltErr) throw new Error(`halts lookup failed: ${haltErr.message}`);
  const haltRows = (halts ?? []) as { id: string; symbol: string }[];
  const symbolByMarket = new Map<string, string>();
  for (const m of mktRows) {
    const halt = haltRows.find((h) => h.id === m.halt_id);
    if (halt) symbolByMarket.set(m.id, halt.symbol);
  }

  return rows.map((r) => ({
    id: r.id,
    market_id: r.market_id,
    bin_id: r.bin_id,
    predicted_price: Number(r.predicted_price),
    user_id: r.user_id,
    stake_micro: Number(r.stake_micro),
    placed_at: r.placed_at,
    status: r.status as Bet['status'],
    symbol: symbolByMarket.get(r.market_id) ?? r.market_id,
  }));
}

export async function listPayoutsForBets(
  betIds: readonly string[],
): Promise<Map<string, Payout>> {
  const result = new Map<string, Payout>();
  if (betIds.length === 0) return result;
  if (!supabaseConfigured) {
    for (const p of FIXTURE_PAYOUTS) {
      if (betIds.includes(p.bet_id)) result.set(p.bet_id, p);
    }
    return result;
  }
  const client = getServerSupabase();
  if (!client) {
    for (const p of FIXTURE_PAYOUTS) {
      if (betIds.includes(p.bet_id)) result.set(p.bet_id, p);
    }
    return result;
  }

  const { data, error } = await client
    .from('payouts')
    .select('bet_id, market_id, source, amount_micro, created_at')
    .in('bet_id', betIds);
  if (error) throw new Error(`payouts query failed: ${error.message}`);

  // Sum bin + bonus sources per bet; refund rolls into bin_amount_micro so
  // downstream receipts treat a refund identically to a zone win.
  for (const row of (data ?? []) as PayoutRow[]) {
    const current = result.get(row.bet_id) ?? {
      bet_id: row.bet_id,
      market_id: row.market_id,
      bin_amount_micro: 0,
      bonus_amount_micro: null,
      created_at: row.created_at,
    };
    const amt = Number(row.amount_micro);
    if (row.source === 'closest_bonus') {
      current.bonus_amount_micro = (current.bonus_amount_micro ?? 0) + amt;
    } else {
      current.bin_amount_micro += amt;
    }
    if (row.created_at < current.created_at) current.created_at = row.created_at;
    result.set(row.bet_id, current);
  }
  return result;
}

// Client-side place-bet call lives in ./place-bet.ts so it can be bundled
// for client components without pulling in the server Supabase helper.
