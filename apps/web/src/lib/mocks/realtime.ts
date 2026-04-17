// TODO(phase-4, phase-5): replace with real Supabase Realtime channels
// (`markets:{id}`, `user:{id}`). The shape of events here mirrors the
// payloads AGENTS.md §Phase 4 specifies, so components can stay unchanged.

export type MarketEvent =
  | { type: 'bin_delta'; market_id: string; bin_idx: number; stake_delta_micro: number; total_pool_micro: number }
  | { type: 'status'; market_id: string; status: 'open' | 'locked' | 'resolved' | 'refunded' }
  | { type: 'resolved'; market_id: string; winning_bin_idx: number; reopen_price: number };

export type UserEvent =
  | { type: 'wallet'; user_id: string; balance_micro: number }
  | { type: 'bet_settled'; user_id: string; bet_id: string; payout_micro: number };

type Listener<E> = (event: E) => void;

class MockChannel<E> {
  private readonly listeners = new Set<Listener<E>>();

  subscribe(fn: Listener<E>): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(event: E): void {
    for (const fn of this.listeners) fn(event);
  }
}

const marketChannels = new Map<string, MockChannel<MarketEvent>>();
const userChannels = new Map<string, MockChannel<UserEvent>>();

export function marketChannel(marketId: string): MockChannel<MarketEvent> {
  let ch = marketChannels.get(marketId);
  if (!ch) {
    ch = new MockChannel<MarketEvent>();
    marketChannels.set(marketId, ch);
  }
  return ch;
}

export function userChannel(userId: string): MockChannel<UserEvent> {
  let ch = userChannels.get(userId);
  if (!ch) {
    ch = new MockChannel<UserEvent>();
    userChannels.set(userId, ch);
  }
  return ch;
}

export type { MockChannel };
