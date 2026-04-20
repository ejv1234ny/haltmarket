// Domain types consumed by the web app. Shapes mirror the Supabase tables
// from migrations 0001_ledger.sql, 0002_halts.sql, 0003_markets.sql,
// 0004_bets.sql, and 0005_resolution.sql so the data layer's real queries
// and its fixture fallback (for local dev without a Supabase URL) both
// produce identical objects — the callers never branch on mode.
//
// Field names match DB columns verbatim. Component props keep these type
// names — changing shape would violate the Phase 7 cleanup scope ("pure
// data-layer substitution, don't touch UI unless a field name changed").

import type { BetStatus, Currency, MarketStatus } from '@haltmarket/shared-types';

export interface Bin {
  id: string;
  market_id: string;
  idx: number;
  low_price: number;
  high_price: number;
  stake_micro: number;
}

export interface Market {
  id: string;
  halt_id: string;
  symbol: string;
  reason_code: string;
  halt_kind: 'volatility' | 'news' | 'regulatory';
  last_price: number;
  halt_time: string;
  closes_at: string;
  halt_end_time: string;
  status: MarketStatus;
  currency: Currency;
  total_pool_micro: number;
  fee_bps: number;
  closest_bonus_bps: number;
  winning_bin_id: string | null;
  reopen_price: number | null;
  closest_bonus_winner_user_id: string | null;
  closest_bonus_amount_micro: number | null;
  bins: Bin[];
}

export interface Bet {
  id: string;
  market_id: string;
  bin_id: string;
  predicted_price: number;
  user_id: string;
  stake_micro: number;
  placed_at: string;
  status: BetStatus;
  symbol: string;
}

export interface Payout {
  bet_id: string;
  market_id: string;
  /** Sum of `payouts` rows with source='bin' for this bet. */
  bin_amount_micro: number;
  /** Sum of `payouts` rows with source='closest_bonus' for this bet, or null. */
  bonus_amount_micro: number | null;
  created_at: string;
}

export interface Wallet {
  user_id: string;
  currency: Currency;
  balance_micro: number;
}

export interface LedgerEntry {
  id: number;
  txn_id: string;
  account: string;
  amount_micro: number;
  reason: string;
  created_at: string;
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

export interface AppUser {
  id: string;
  email: string;
  handle: string;
}
