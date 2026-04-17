// TODO(phase-3): replace these local interfaces with types from
// `@haltmarket/shared-types` once Codespace A ships the real Supabase schema
// (migration 0003_markets.sql). The shapes here mirror `docs/design.md` §5 so
// the swap is a type rename, not a code change.

import type { BetStatus, Currency, MarketStatus } from '@haltmarket/shared-types';

export interface MockBin {
  id: string;
  market_id: string;
  idx: number;
  low_price: number;
  high_price: number;
  stake_micro: number;
}

export interface MockMarket {
  id: string;
  halt_id: string;
  symbol: string;
  reason_code: string;
  last_price: number;
  halt_time: string;
  closes_at: string;
  halt_end_time: string;
  status: MarketStatus;
  currency: Currency;
  total_pool_micro: number;
  fee_bps: number;
  winning_bin_id: string | null;
  reopen_price: number | null;
  bins: MockBin[];
}

export interface MockBet {
  id: string;
  market_id: string;
  bin_id: string;
  user_id: string;
  stake_micro: number;
  placed_at: string;
  status: BetStatus;
  symbol: string;
  predicted_price: number;
}

export interface MockPayout {
  bet_id: string;
  market_id: string;
  amount_micro: number;
  created_at: string;
}

export interface MockWallet {
  user_id: string;
  currency: Currency;
  balance_micro: number;
}

export interface MockLedgerEntry {
  id: number;
  txn_id: string;
  account: string;
  amount_micro: number;
  reason: string;
  created_at: string;
}

export interface MockLeaderboardRow {
  rank: number;
  user_id: string;
  handle: string;
  total_staked_micro: number;
  net_pnl_micro: number;
  wins: number;
  bets: number;
}

export interface MockUser {
  id: string;
  email: string;
  handle: string;
}
