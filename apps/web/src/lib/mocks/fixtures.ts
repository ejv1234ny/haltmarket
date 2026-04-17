// TODO(phase-3, phase-4, phase-5): these fixtures stand in for real Supabase
// rows while Codespace A finishes the schema + bet/resolution pipeline.
// Swap-out happens in the post-critical-path follow-up PR: replace these
// exports with queries against the real markets/bets/payouts tables.

import { buildLadder } from '../bins';
import { usdToMicro } from '../format';
import type {
  MockBet,
  MockLedgerEntry,
  MockMarket,
  MockPayout,
  MockUser,
  MockWallet,
  MockLeaderboardRow,
} from './types';

export const MOCK_USER: MockUser = {
  id: 'user-mock-1',
  email: 'you@haltmarket.dev',
  handle: 'you',
};

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function secondsFromNow(s: number): string {
  return new Date(Date.now() + s * 1000).toISOString();
}

function seedLadder(
  marketId: string,
  lastPrice: number,
  stakesUsd: Partial<Record<number, number>>,
) {
  const bins = buildLadder(marketId, lastPrice);
  let total = 0;
  for (const bin of bins) {
    const usd = stakesUsd[bin.idx] ?? 0;
    const micro = usdToMicro(usd);
    bin.stake_micro = micro;
    total += micro;
  }
  return { bins, total };
}

function mockMarket(input: {
  id: string;
  symbol: string;
  lastPrice: number;
  haltMinutesAgo: number;
  closesInSec: number;
  stakesUsd: Partial<Record<number, number>>;
  reasonCode?: string;
}): MockMarket {
  const { bins, total } = seedLadder(input.id, input.lastPrice, input.stakesUsd);
  return {
    id: input.id,
    halt_id: `halt-${input.id}`,
    symbol: input.symbol,
    reason_code: input.reasonCode ?? 'LUDP',
    last_price: input.lastPrice,
    halt_time: minutesAgo(input.haltMinutesAgo),
    closes_at: secondsFromNow(input.closesInSec),
    halt_end_time: secondsFromNow(input.closesInSec + 210),
    status: 'open',
    currency: 'USDC',
    total_pool_micro: total,
    fee_bps: 500,
    winning_bin_id: null,
    reopen_price: null,
    bins,
  };
}

export const MOCK_MARKETS: MockMarket[] = [
  mockMarket({
    id: 'mkt-nvda-1',
    symbol: 'NVDA',
    lastPrice: 118.42,
    haltMinutesAgo: 0,
    closesInSec: 72,
    stakesUsd: { 8: 420, 9: 1200, 10: 2400, 11: 1800, 12: 640 },
  }),
  mockMarket({
    id: 'mkt-tsla-1',
    symbol: 'TSLA',
    lastPrice: 241.78,
    haltMinutesAgo: 1,
    closesInSec: 28,
    stakesUsd: { 7: 300, 8: 900, 9: 2100, 10: 2800, 11: 1500, 12: 400 },
  }),
  mockMarket({
    id: 'mkt-amc-1',
    symbol: 'AMC',
    lastPrice: 4.12,
    haltMinutesAgo: 2,
    closesInSec: 15,
    stakesUsd: { 9: 80, 10: 220, 11: 150, 12: 40 },
  }),
  {
    ...mockMarket({
      id: 'mkt-gme-1',
      symbol: 'GME',
      lastPrice: 22.14,
      haltMinutesAgo: 6,
      closesInSec: -1,
      stakesUsd: { 9: 200, 10: 480, 11: 900, 12: 600, 13: 180 },
    }),
    status: 'locked',
    closes_at: minutesAgo(4),
  },
];

export const RESOLVED_MARKET: MockMarket = (() => {
  const base = mockMarket({
    id: 'mkt-aapl-1',
    symbol: 'AAPL',
    lastPrice: 189.5,
    haltMinutesAgo: 18,
    closesInSec: -900,
    stakesUsd: { 8: 120, 9: 280, 10: 910, 11: 740, 12: 210 },
  });
  const winning = base.bins[10]!;
  return {
    ...base,
    status: 'resolved',
    closes_at: minutesAgo(15),
    winning_bin_id: winning.id,
    reopen_price: 191.05,
  };
})();

export const MOCK_WALLET: MockWallet = {
  user_id: MOCK_USER.id,
  currency: 'USDC',
  balance_micro: usdToMicro(847.31),
};

export const MOCK_BETS: MockBet[] = [
  {
    id: 'bet-1',
    market_id: RESOLVED_MARKET.id,
    bin_id: RESOLVED_MARKET.bins[10]!.id,
    user_id: MOCK_USER.id,
    stake_micro: usdToMicro(50),
    placed_at: minutesAgo(17),
    status: 'settled',
    symbol: RESOLVED_MARKET.symbol,
    predicted_price: 191.25,
  },
  {
    id: 'bet-2',
    market_id: 'mkt-nvda-1',
    bin_id: `mkt-nvda-1-bin-10`,
    user_id: MOCK_USER.id,
    stake_micro: usdToMicro(25),
    placed_at: minutesAgo(0),
    status: 'active',
    symbol: 'NVDA',
    predicted_price: 118.9,
  },
];

export const MOCK_PAYOUTS: MockPayout[] = [
  {
    bet_id: 'bet-1',
    market_id: RESOLVED_MARKET.id,
    amount_micro: usdToMicro(127.42),
    created_at: minutesAgo(14),
  },
];

export const MOCK_LEDGER: MockLedgerEntry[] = [
  { id: 7, txn_id: 't-7', account: 'user_wallet', amount_micro: usdToMicro(127.42), reason: 'payout', created_at: minutesAgo(14) },
  { id: 6, txn_id: 't-6', account: 'user_wallet', amount_micro: usdToMicro(-25), reason: 'bet_placed', created_at: minutesAgo(0) },
  { id: 5, txn_id: 't-5', account: 'user_wallet', amount_micro: usdToMicro(-50), reason: 'bet_placed', created_at: minutesAgo(17) },
  { id: 4, txn_id: 't-4', account: 'user_wallet', amount_micro: usdToMicro(500), reason: 'deposit', created_at: minutesAgo(1440) },
];

export const MOCK_LEADERBOARD: MockLeaderboardRow[] = [
  { rank: 1, user_id: 'u-a', handle: 'pinpoint', total_staked_micro: usdToMicro(12_410), net_pnl_micro: usdToMicro(3_820), wins: 41, bets: 112 },
  { rank: 2, user_id: 'u-b', handle: 'halt_hunter', total_staked_micro: usdToMicro(8_240), net_pnl_micro: usdToMicro(1_905), wins: 27, bets: 88 },
  { rank: 3, user_id: 'u-c', handle: 'gamma_queen', total_staked_micro: usdToMicro(5_980), net_pnl_micro: usdToMicro(1_104), wins: 22, bets: 71 },
  { rank: 4, user_id: MOCK_USER.id, handle: MOCK_USER.handle, total_staked_micro: usdToMicro(75), net_pnl_micro: usdToMicro(52.42), wins: 1, bets: 2 },
  { rank: 5, user_id: 'u-d', handle: 'vega_vandal', total_staked_micro: usdToMicro(1_205), net_pnl_micro: usdToMicro(-310), wins: 4, bets: 18 },
];

export function getMarketById(id: string): MockMarket | undefined {
  return [...MOCK_MARKETS, RESOLVED_MARKET].find((m) => m.id === id);
}

export function listOpenMarkets(): MockMarket[] {
  return MOCK_MARKETS.filter((m) => m.status === 'open');
}

export function listAllMarkets(): MockMarket[] {
  return [...MOCK_MARKETS, RESOLVED_MARKET];
}
