// Server-side read helpers for market data. Pages call these from Server
// Components via `getServerSupabase()`. The helpers return shapes compatible
// with the MockMarket / MockBet structural types so consumer components
// don't branch on mocked vs real data.

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  MockBet,
  MockLedgerEntry,
  MockMarket,
  MockPayout,
  MockWallet,
} from '../mocks/types';

type MarketStatus = MockMarket['status'];
type HaltKind = MockMarket['halt_kind'];

interface HaltRow {
  id: string;
  symbol: string;
  reason_code: string;
  halt_kind: HaltKind;
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

interface MarketRow {
  id: string;
  halt_id: string;
  status: MarketStatus;
  last_price: number | string;
  closes_at: string;
  currency: 'USDC';
  total_pool_micro: number | string;
  fee_bps: number;
  closest_bonus_bps: number;
  winning_bin_id: string | null;
  halts: HaltRow | HaltRow[] | null;
  bins?: BinRow[];
}

interface ResolutionRow {
  market_id: string;
  reopen_price: number | string;
  closest_bonus_winner_user_id: string | null;
  closest_bonus_micro: number | string | null;
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

function normalizeHalt(h: HaltRow | HaltRow[] | null): HaltRow | null {
  if (!h) return null;
  return Array.isArray(h) ? (h[0] ?? null) : h;
}

function toMarket(row: MarketRow, bins: BinRow[], resolution?: ResolutionRow | null): MockMarket {
  const halt = normalizeHalt(row.halts);
  const reopen = resolution ? num(resolution.reopen_price) : null;
  const bonusWinner = resolution?.closest_bonus_winner_user_id ?? null;
  const bonusAmount = resolution?.closest_bonus_micro != null
    ? Number(resolution.closest_bonus_micro)
    : null;
  return {
    id: row.id,
    halt_id: row.halt_id,
    symbol: halt?.symbol ?? '',
    reason_code: halt?.reason_code ?? '',
    halt_kind: halt?.halt_kind ?? 'volatility',
    last_price: num(row.last_price),
    halt_time: halt?.halt_time ?? new Date(0).toISOString(),
    closes_at: row.closes_at,
    halt_end_time: halt?.halt_end_time ?? row.closes_at,
    status: row.status,
    currency: row.currency,
    total_pool_micro: Number(row.total_pool_micro),
    fee_bps: row.fee_bps,
    closest_bonus_bps: row.closest_bonus_bps,
    winning_bin_id: row.winning_bin_id,
    reopen_price: reopen && reopen > 0 ? reopen : null,
    closest_bonus_winner_user_id: bonusWinner,
    closest_bonus_amount_micro: bonusAmount,
    bins: bins
      .slice()
      .sort((a, b) => a.idx - b.idx)
      .map((b) => ({
        id: b.id,
        market_id: b.market_id,
        idx: b.idx,
        low_price: num(b.low_price),
        high_price: num(b.high_price),
        stake_micro: Number(b.stake_micro),
      })),
  };
}

const MARKET_SELECT =
  'id, halt_id, status, last_price, closes_at, currency, total_pool_micro, ' +
  'fee_bps, closest_bonus_bps, winning_bin_id, ' +
  'halts!inner(id, symbol, reason_code, halt_kind, halt_time, halt_end_time, reopen_price)';

export async function listMarkets(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<MockMarket[]> {
  const limit = opts.limit ?? 60;
  const { data: marketRows, error } = await supabase
    .from('markets')
    .select(MARKET_SELECT)
    .order('closes_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listMarkets error', error);
    return [];
  }
  const rows = (marketRows ?? []) as unknown as MarketRow[];
  if (rows.length === 0) return [];

  const marketIds = rows.map((r) => r.id);
  const [{ data: binRows }, { data: resRows }] = await Promise.all([
    supabase
      .from('bins')
      .select('id, market_id, idx, low_price, high_price, stake_micro')
      .in('market_id', marketIds),
    supabase
      .from('market_resolutions')
      .select('market_id, reopen_price, closest_bonus_winner_user_id, closest_bonus_micro')
      .in('market_id', marketIds),
  ]);

  const binsByMarket = new Map<string, BinRow[]>();
  for (const b of (binRows ?? []) as BinRow[]) {
    const list = binsByMarket.get(b.market_id) ?? [];
    list.push(b);
    binsByMarket.set(b.market_id, list);
  }
  const resByMarket = new Map<string, ResolutionRow>();
  for (const r of (resRows ?? []) as ResolutionRow[]) {
    resByMarket.set(r.market_id, r);
  }

  return rows.map((m) => toMarket(m, binsByMarket.get(m.id) ?? [], resByMarket.get(m.id)));
}

export async function getMarket(
  supabase: SupabaseClient,
  marketId: string,
): Promise<MockMarket | null> {
  const [
    { data: marketRow, error: marketErr },
    { data: binRows, error: binErr },
    { data: resRow },
  ] = await Promise.all([
    supabase.from('markets').select(MARKET_SELECT).eq('id', marketId).maybeSingle(),
    supabase
      .from('bins')
      .select('id, market_id, idx, low_price, high_price, stake_micro')
      .eq('market_id', marketId)
      .order('idx', { ascending: true }),
    supabase
      .from('market_resolutions')
      .select('market_id, reopen_price, closest_bonus_winner_user_id, closest_bonus_micro')
      .eq('market_id', marketId)
      .maybeSingle(),
  ]);
  if (marketErr) {
    console.error('getMarket error', marketErr);
    return null;
  }
  if (!marketRow) return null;
  if (binErr) {
    console.error('getMarket bins error', binErr);
    return null;
  }
  return toMarket(
    marketRow as unknown as MarketRow,
    (binRows ?? []) as BinRow[],
    (resRow ?? null) as ResolutionRow | null,
  );
}

export async function getUserWallet(
  supabase: SupabaseClient,
  userId: string,
): Promise<MockWallet> {
  const { data, error } = await supabase
    .from('wallets')
    .select('balance_micro, currency')
    .eq('user_id', userId)
    .eq('account', 'user_wallet')
    .eq('currency', 'USDC')
    .maybeSingle();
  if (error) {
    console.error('getUserWallet error', error);
  }
  return {
    user_id: userId,
    currency: 'USDC',
    balance_micro: data ? Number(data.balance_micro) : 0,
  };
}

export async function listLedgerEntries(
  supabase: SupabaseClient,
  userId: string,
  limit = 20,
): Promise<MockLedgerEntry[]> {
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('id, txn_id, account, amount_micro, reason, created_at')
    .eq('user_id', userId)
    .eq('currency', 'USDC')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listLedgerEntries error', error);
    return [];
  }
  return (data ?? []).map((r, i) => ({
    id: Number(r.id) || i,
    txn_id: String(r.txn_id),
    account: String(r.account),
    amount_micro: Number(r.amount_micro),
    reason: String(r.reason),
    created_at: String(r.created_at),
  }));
}

interface BetRow {
  id: string;
  market_id: string;
  bin_id: string;
  user_id: string;
  stake_micro: number | string;
  predicted_price: number | string;
  placed_at: string;
  status: MockBet['status'];
  markets: { id: string; halts: { symbol: string } | { symbol: string }[] | null } | null;
}

export async function listUserBets(
  supabase: SupabaseClient,
  userId: string,
  limit = 50,
): Promise<MockBet[]> {
  const { data, error } = await supabase
    .from('bets')
    .select(
      'id, market_id, bin_id, user_id, stake_micro, predicted_price, placed_at, status, ' +
        'markets!inner(id, halts!inner(symbol))',
    )
    .eq('user_id', userId)
    .order('placed_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listUserBets error', error);
    return [];
  }
  return ((data ?? []) as unknown as BetRow[]).map((r) => {
    const halt = r.markets?.halts;
    const symbol = Array.isArray(halt) ? halt[0]?.symbol ?? '' : halt?.symbol ?? '';
    return {
      id: r.id,
      market_id: r.market_id,
      bin_id: r.bin_id,
      user_id: r.user_id,
      stake_micro: Number(r.stake_micro),
      predicted_price: num(r.predicted_price),
      placed_at: r.placed_at,
      status: r.status,
      symbol,
    };
  });
}

interface PayoutRow {
  bet_id: string;
  market_id: string;
  source: 'bin' | 'closest_bonus' | 'refund';
  amount_micro: number | string;
  created_at: string;
}

export async function listUserPayouts(
  supabase: SupabaseClient,
  userId: string,
): Promise<MockPayout[]> {
  const { data, error } = await supabase
    .from('payouts')
    .select('bet_id, market_id, source, amount_micro, created_at')
    .eq('user_id', userId);
  if (error) {
    console.error('listUserPayouts error', error);
    return [];
  }
  const byBet = new Map<
    string,
    { market_id: string; bin: number; bonus: number | null; created_at: string }
  >();
  for (const r of (data ?? []) as PayoutRow[]) {
    const prior = byBet.get(r.bet_id) ?? {
      market_id: r.market_id,
      bin: 0,
      bonus: null,
      created_at: r.created_at,
    };
    const amt = Number(r.amount_micro);
    if (r.source === 'bin' || r.source === 'refund') prior.bin += amt;
    if (r.source === 'closest_bonus') prior.bonus = (prior.bonus ?? 0) + amt;
    if (r.created_at > prior.created_at) prior.created_at = r.created_at;
    byBet.set(r.bet_id, prior);
  }
  return Array.from(byBet.entries()).map(([bet_id, v]) => ({
    bet_id,
    market_id: v.market_id,
    bin_amount_micro: v.bin,
    bonus_amount_micro: v.bonus,
    created_at: v.created_at,
  }));
}

export async function getUserBetForMarket(
  supabase: SupabaseClient,
  userId: string,
  marketId: string,
): Promise<MockBet | null> {
  const { data, error } = await supabase
    .from('bets')
    .select('id, market_id, bin_id, user_id, stake_micro, predicted_price, placed_at, status')
    .eq('user_id', userId)
    .eq('market_id', marketId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    market_id: data.market_id,
    bin_id: data.bin_id,
    user_id: data.user_id,
    stake_micro: Number(data.stake_micro),
    predicted_price: num(data.predicted_price),
    placed_at: data.placed_at,
    status: data.status,
    symbol: '',
  };
}

interface LeaderboardRpcRow {
  user_id: string;
  handle: string;
  total_staked_micro: number | string;
  net_pnl_micro: number | string;
  wins: number;
  bets: number;
}

export interface LeaderboardRow {
  rank: number;
  user_id: string;
  handle: string;
  total_staked_micro: number;
  net_pnl_micro: number;
  wins: number;
  bets: number;
}

export async function getLeaderboard(
  supabase: SupabaseClient,
  limit = 50,
): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase.rpc('get_leaderboard', { p_limit: limit });
  if (error) {
    console.error('getLeaderboard error', error);
    return [];
  }
  const rows = (data ?? []) as LeaderboardRpcRow[];
  return rows.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id,
    handle: r.handle,
    total_staked_micro: Number(r.total_staked_micro),
    net_pnl_micro: Number(r.net_pnl_micro),
    wins: r.wins,
    bets: r.bets,
  }));
}

export async function getUserPayoutForBet(
  supabase: SupabaseClient,
  betId: string,
): Promise<MockPayout | null> {
  const { data } = await supabase
    .from('payouts')
    .select('bet_id, market_id, source, amount_micro, created_at')
    .eq('bet_id', betId);
  const rows = (data ?? []) as PayoutRow[];
  if (rows.length === 0) return null;
  let bin = 0;
  let bonus: number | null = null;
  let marketId = rows[0]!.market_id;
  let createdAt = rows[0]!.created_at;
  for (const r of rows) {
    const amt = Number(r.amount_micro);
    if (r.source === 'bin' || r.source === 'refund') bin += amt;
    if (r.source === 'closest_bonus') bonus = (bonus ?? 0) + amt;
    if (r.created_at > createdAt) createdAt = r.created_at;
    marketId = r.market_id;
  }
  return {
    bet_id: betId,
    market_id: marketId,
    bin_amount_micro: bin,
    bonus_amount_micro: bonus,
    created_at: createdAt,
  };
}
