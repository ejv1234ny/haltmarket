export type Currency = 'USD' | 'USDC';

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type MarketStatus = 'open' | 'locked' | 'resolved' | 'refunded';

export type BetStatus = 'active' | 'settled' | 'refunded';

export type LedgerAccount =
  | 'user_wallet'
  | 'market_pool'
  | 'house_fees'
  | 'pending_deposits'
  | 'pending_withdrawals';

export type { Database } from './database.js';
