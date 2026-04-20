// Leaderboard aggregation. Crosses all users, so RLS on `bets` / `payouts`
// (owner-only select) cannot satisfy it — the service-role client is
// required. Without a service key configured the page falls back to
// fixture data so local dev and CI stay functional.
//
// Aggregation:
//   * total_staked_micro = SUM(bets.stake_micro) for status != 'refunded'
//   * total_payout_micro = SUM(payouts.amount_micro) across all sources
//   * wins                = COUNT(DISTINCT bets with any positive bin payout)
//   * bets                = COUNT(bets) for the user
//   * net_pnl_micro       = total_payout_micro - total_staked_micro
//   * threshold           = ≥ 5 bets (Phase 7 cleanup spec)

import { getServiceSupabase } from '../supabase/service';
import { serviceRoleConfigured } from '../env';
import { FIXTURE_LEADERBOARD } from './fixtures';
import type { LeaderboardRow } from './types';

interface BetAgg {
  user_id: string;
  stake_micro: number | string;
  status: string;
}

interface PayoutAgg {
  user_id: string;
  bet_id: string;
  amount_micro: number | string;
  source: string;
}

interface ProfileRow {
  id: string;
  handle: string | null;
}

const MIN_BETS_FOR_LEADERBOARD = 5;

export async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  if (!serviceRoleConfigured) return FIXTURE_LEADERBOARD;
  const client = getServiceSupabase();
  if (!client) return FIXTURE_LEADERBOARD;

  const [bets, payouts, profiles] = await Promise.all([
    client.from('bets').select('user_id, stake_micro, status'),
    client.from('payouts').select('user_id, bet_id, amount_micro, source'),
    // `users` is the optional public profile table; many projects replace
    // this with a direct `auth.users` read via a SECURITY DEFINER RPC. For
    // Phase 7 cleanup we prefer the profile handle when present and fall
    // back to a truncated uuid so the list always renders.
    client.from('users').select('id, handle'),
  ]);

  if (bets.error) throw new Error(`bets agg failed: ${bets.error.message}`);
  if (payouts.error) throw new Error(`payouts agg failed: ${payouts.error.message}`);
  if (profiles.error) throw new Error(`users agg failed: ${profiles.error.message}`);

  const stakeTotals = new Map<string, number>();
  const betCounts = new Map<string, number>();
  for (const row of (bets.data ?? []) as BetAgg[]) {
    if (row.status === 'refunded') continue;
    stakeTotals.set(
      row.user_id,
      (stakeTotals.get(row.user_id) ?? 0) + Number(row.stake_micro),
    );
    betCounts.set(row.user_id, (betCounts.get(row.user_id) ?? 0) + 1);
  }

  const payoutTotals = new Map<string, number>();
  const wins = new Map<string, Set<string>>();
  for (const row of (payouts.data ?? []) as PayoutAgg[]) {
    payoutTotals.set(
      row.user_id,
      (payoutTotals.get(row.user_id) ?? 0) + Number(row.amount_micro),
    );
    if (row.source === 'bin' || row.source === 'closest_bonus') {
      const set = wins.get(row.user_id) ?? new Set<string>();
      set.add(row.bet_id);
      wins.set(row.user_id, set);
    }
  }

  const handles = new Map<string, string>();
  for (const p of (profiles.data ?? []) as ProfileRow[]) {
    if (p.handle) handles.set(p.id, p.handle);
  }

  const rows: Omit<LeaderboardRow, 'rank'>[] = [];
  for (const [userId, bets] of betCounts.entries()) {
    if (bets < MIN_BETS_FOR_LEADERBOARD) continue;
    const staked = stakeTotals.get(userId) ?? 0;
    const paid = payoutTotals.get(userId) ?? 0;
    rows.push({
      user_id: userId,
      handle: handles.get(userId) ?? userId.slice(0, 8),
      total_staked_micro: staked,
      net_pnl_micro: paid - staked,
      wins: (wins.get(userId) ?? new Set()).size,
      bets,
    });
  }

  rows.sort((a, b) => b.net_pnl_micro - a.net_pnl_micro);
  return rows.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
}
