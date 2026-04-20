// Fixture data used when NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are unset
// (local dev without a Supabase project, CI Playwright jobs). Shape matches
// the real-query results in `./markets.ts` etc., so the data layer is the
// only place that branches on `supabaseConfigured`.
//
// NOT test-only — the Playwright specs rely on these as the "seeded"
// starting state for the fixture-backed flow. Changing symbols / IDs here
// is a breaking change for the e2e suite.

import { buildLadder } from '../bins';
import { usdToMicro } from '../format';
import type {
  Bet,
  LeaderboardRow,
  LedgerEntry,
  Market,
  Payout,
  Wallet,
  AppUser,
} from './types';

// Zero-UUID for the unauthenticated fallback. Any page that queries by
// user_id passes this straight to Postgres; a valid-UUID format avoids
// "invalid input syntax for type uuid" when the real backend is wired
// and the visitor isn't signed in. RLS filters rows out naturally
// because this id doesn't exist in auth.users.
export const DEMO_USER: AppUser = {
  id: '00000000-0000-0000-0000-000000000001',
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

const HALT_KIND_BY_CODE: Record<string, 'volatility' | 'news' | 'regulatory'> = {
  LUDP: 'volatility',
  T1: 'news',
  T12: 'news',
  H10: 'regulatory',
};

function fixtureMarket(input: {
  id: string;
  symbol: string;
  lastPrice: number;
  haltMinutesAgo: number;
  closesInSec: number;
  stakesUsd: Partial<Record<number, number>>;
  reasonCode?: string;
}): Market {
  const { bins, total } = seedLadder(input.id, input.lastPrice, input.stakesUsd);
  const reason = input.reasonCode ?? 'LUDP';
  return {
    id: input.id,
    halt_id: `halt-${input.id}`,
    symbol: input.symbol,
    reason_code: reason,
    halt_kind: HALT_KIND_BY_CODE[reason] ?? 'volatility',
    last_price: input.lastPrice,
    halt_time: minutesAgo(input.haltMinutesAgo),
    closes_at: secondsFromNow(input.closesInSec),
    halt_end_time: secondsFromNow(input.closesInSec + 210),
    status: 'open',
    currency: 'USDC',
    total_pool_micro: total,
    fee_bps: 500,
    closest_bonus_bps: 700,
    winning_bin_id: null,
    reopen_price: null,
    closest_bonus_winner_user_id: null,
    closest_bonus_amount_micro: null,
    bins,
  };
}

export const FIXTURE_MARKETS: Market[] = [
  fixtureMarket({
    id: 'mkt-nvda-1',
    symbol: 'NVDA',
    lastPrice: 118.42,
    haltMinutesAgo: 0,
    closesInSec: 72,
    stakesUsd: { 8: 420, 9: 1200, 10: 2400, 11: 1800, 12: 640 },
  }),
  fixtureMarket({
    id: 'mkt-tsla-1',
    symbol: 'TSLA',
    lastPrice: 241.78,
    haltMinutesAgo: 1,
    closesInSec: 28,
    stakesUsd: { 7: 300, 8: 900, 9: 2100, 10: 2800, 11: 1500, 12: 400 },
  }),
  fixtureMarket({
    id: 'mkt-amc-1',
    symbol: 'AMC',
    lastPrice: 4.12,
    haltMinutesAgo: 2,
    closesInSec: 15,
    stakesUsd: { 9: 80, 10: 220, 11: 150, 12: 40 },
  }),
  {
    ...fixtureMarket({
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

export const RESOLVED_FIXTURE_MARKET: Market = (() => {
  const base = fixtureMarket({
    id: 'mkt-aapl-1',
    symbol: 'AAPL',
    lastPrice: 189.5,
    haltMinutesAgo: 18,
    closesInSec: -900,
    stakesUsd: { 8: 120, 9: 280, 10: 910, 11: 740, 12: 210 },
  });
  const winning = base.bins[10]!;
  const bonusMicro = Math.floor((base.total_pool_micro * 700) / 10_000);
  return {
    ...base,
    status: 'resolved',
    closes_at: minutesAgo(15),
    winning_bin_id: winning.id,
    reopen_price: 191.05,
    closest_bonus_winner_user_id: DEMO_USER.id,
    closest_bonus_amount_micro: bonusMicro,
  };
})();

export const FIXTURE_WALLET: Wallet = {
  user_id: DEMO_USER.id,
  currency: 'USDC',
  balance_micro: usdToMicro(847.31),
};

export const FIXTURE_BETS: Bet[] = [
  {
    id: 'bet-1',
    market_id: RESOLVED_FIXTURE_MARKET.id,
    bin_id: RESOLVED_FIXTURE_MARKET.bins[10]!.id,
    user_id: DEMO_USER.id,
    stake_micro: usdToMicro(50),
    placed_at: minutesAgo(17),
    status: 'settled',
    symbol: RESOLVED_FIXTURE_MARKET.symbol,
    predicted_price: 191.25,
  },
  {
    id: 'bet-2',
    market_id: 'mkt-nvda-1',
    bin_id: `mkt-nvda-1-bin-10`,
    user_id: DEMO_USER.id,
    stake_micro: usdToMicro(25),
    placed_at: minutesAgo(0),
    status: 'active',
    symbol: 'NVDA',
    predicted_price: 118.9,
  },
];

export const FIXTURE_PAYOUTS: Payout[] = [
  {
    bet_id: 'bet-1',
    market_id: RESOLVED_FIXTURE_MARKET.id,
    bin_amount_micro: usdToMicro(113.2),
    bonus_amount_micro: RESOLVED_FIXTURE_MARKET.closest_bonus_amount_micro,
    created_at: minutesAgo(14),
  },
];

export const FIXTURE_LEDGER: LedgerEntry[] = [
  { id: 7, txn_id: 't-7', account: 'user_wallet', amount_micro: usdToMicro(127.42), reason: 'payout', created_at: minutesAgo(14) },
  { id: 6, txn_id: 't-6', account: 'user_wallet', amount_micro: usdToMicro(-25), reason: 'bet_placed', created_at: minutesAgo(0) },
  { id: 5, txn_id: 't-5', account: 'user_wallet', amount_micro: usdToMicro(-50), reason: 'bet_placed', created_at: minutesAgo(17) },
  { id: 4, txn_id: 't-4', account: 'user_wallet', amount_micro: usdToMicro(500), reason: 'deposit', created_at: minutesAgo(1440) },
];

export const FIXTURE_LEADERBOARD: LeaderboardRow[] = [
  { rank: 1, user_id: 'u-a', handle: 'pinpoint', total_staked_micro: usdToMicro(12_410), net_pnl_micro: usdToMicro(3_820), wins: 41, bets: 112 },
  { rank: 2, user_id: 'u-b', handle: 'halt_hunter', total_staked_micro: usdToMicro(8_240), net_pnl_micro: usdToMicro(1_905), wins: 27, bets: 88 },
  { rank: 3, user_id: 'u-c', handle: 'gamma_queen', total_staked_micro: usdToMicro(5_980), net_pnl_micro: usdToMicro(1_104), wins: 22, bets: 71 },
  { rank: 4, user_id: DEMO_USER.id, handle: DEMO_USER.handle, total_staked_micro: usdToMicro(75), net_pnl_micro: usdToMicro(52.42), wins: 1, bets: 2 },
  { rank: 5, user_id: 'u-d', handle: 'vega_vandal', total_staked_micro: usdToMicro(1_205), net_pnl_micro: usdToMicro(-310), wins: 4, bets: 18 },
];

export function fixtureMarketById(id: string): Market | undefined {
  return [...FIXTURE_MARKETS, RESOLVED_FIXTURE_MARKET].find((m) => m.id === id);
}

export function fixtureAllMarkets(): Market[] {
  return [...FIXTURE_MARKETS, RESOLVED_FIXTURE_MARKET];
}
