// Public surface of the web-data layer.
//
// Split into two classes of exports:
//
//   1. CLIENT-SAFE (this file) — types, browser-side helpers (callPlaceBet,
//      realtime hooks, fallback publishers, DEMO_USER fixture). Importing
//      these from client components is safe.
//
//   2. SERVER-ONLY (./markets, ./bets, ./wallet, ./leaderboard) — reads
//      that use the server Supabase client or service role. Server
//      components import directly from those modules, never from this
//      file, so Next.js's bundler doesn't pull server-only code into the
//      client graph.

export type {
  AppUser,
  Bet,
  Bin,
  LeaderboardRow,
  LedgerEntry,
  Market,
  Payout,
  Wallet,
} from './types';

export { DEMO_USER } from './fixtures';

export {
  callPlaceBet,
  PlaceBetCallError,
} from './place-bet';
export type { PlaceBetArgs, PlaceBetReceipt } from './place-bet';

export {
  publishFallbackMarketEvent,
  publishFallbackUserEvent,
  useMarketEvents,
  useUserEvents,
} from './realtime';
export type { BinDelta, MarketEvent, MarketResolved, UserEvent, WalletUpdated } from './realtime';
