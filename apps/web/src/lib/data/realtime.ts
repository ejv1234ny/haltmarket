'use client';

// Thin Supabase Realtime wrapper for `markets:{market_id}` and
// `user:{user_id}` channels — plus an in-memory fallback for fixture mode
// so components don't need to branch on `supabaseConfigured`.
//
// Event shapes mirror what Phase 4's place-bet edge function broadcasts:
//   markets:{id}  event='bin_delta'  → { bin_id, new_stake_micro, new_total_pool_micro }
// Resolution updates arrive via a Postgres Changes subscription on the
// `markets` row (Phase 5's `resolve_market` RPC writes status='resolved'
// + winning_bin_id). The `user:{id}` channel currently carries wallet
// Postgres Changes only; Phase 6 will add broadcast notifications.

import { useEffect } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getBrowserSupabase } from '../supabase/browser';
import { supabaseConfigured } from '../env';

export interface BinDelta {
  type: 'bin_delta';
  market_id: string;
  bin_id: string;
  new_stake_micro: number;
  new_total_pool_micro: number;
}

export interface MarketResolved {
  type: 'resolved';
  market_id: string;
  winning_bin_id: string | null;
  reopen_price: number | null;
}

export type MarketEvent = BinDelta | MarketResolved;

export interface WalletUpdated {
  type: 'wallet';
  user_id: string;
  balance_micro: number;
}

export type UserEvent = WalletUpdated;

type Handler<E> = (event: E) => void;

// -----------------------------------------------------------------------------
// In-memory fallback (fixture mode). Mirrors the old mocks/realtime.ts so
// the bet-form's optimistic update still broadcasts to subscribed
// components when the real backend isn't wired.
// -----------------------------------------------------------------------------

class FallbackChannel<E> {
  private readonly handlers = new Set<Handler<E>>();

  subscribe(fn: Handler<E>): () => void {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  publish(event: E): void {
    for (const fn of this.handlers) fn(event);
  }
}

const fallbackMarketChannels = new Map<string, FallbackChannel<MarketEvent>>();
const fallbackUserChannels = new Map<string, FallbackChannel<UserEvent>>();

function fallbackMarket(id: string): FallbackChannel<MarketEvent> {
  let ch = fallbackMarketChannels.get(id);
  if (!ch) {
    ch = new FallbackChannel<MarketEvent>();
    fallbackMarketChannels.set(id, ch);
  }
  return ch;
}

function fallbackUser(id: string): FallbackChannel<UserEvent> {
  let ch = fallbackUserChannels.get(id);
  if (!ch) {
    ch = new FallbackChannel<UserEvent>();
    fallbackUserChannels.set(id, ch);
  }
  return ch;
}

/**
 * Fixture-mode publishers — used by the optimistic branch in BetForm when
 * `supabaseConfigured === false`. No-op when Supabase is wired (the edge
 * function broadcasts authoritatively over Realtime instead).
 */
export function publishFallbackMarketEvent(event: MarketEvent): void {
  if (supabaseConfigured) return;
  fallbackMarket(event.market_id).publish(event);
}

export function publishFallbackUserEvent(event: UserEvent): void {
  if (supabaseConfigured) return;
  fallbackUser(event.user_id).publish(event);
}

// -----------------------------------------------------------------------------
// React hooks. Subscription lifecycle is tied to effect mount/unmount, so
// unmounting a component removes the listener cleanly (no leaks across
// navigations).
// -----------------------------------------------------------------------------

export function useMarketEvents(marketId: string, onEvent: Handler<MarketEvent>): void {
  useEffect(() => {
    if (!supabaseConfigured) {
      return fallbackMarket(marketId).subscribe(onEvent);
    }
    const supabase = getBrowserSupabase();
    if (!supabase) return fallbackMarket(marketId).subscribe(onEvent);

    const channel: RealtimeChannel = supabase
      .channel(`markets:${marketId}`)
      .on(
        'broadcast',
        { event: 'bin_delta' },
        ({ payload }) => {
          const p = payload as {
            bin_id?: string;
            new_stake_micro?: number | string;
            new_total_pool_micro?: number | string;
          };
          if (!p.bin_id) return;
          onEvent({
            type: 'bin_delta',
            market_id: marketId,
            bin_id: p.bin_id,
            new_stake_micro: Number(p.new_stake_micro ?? 0),
            new_total_pool_micro: Number(p.new_total_pool_micro ?? 0),
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'markets', filter: `id=eq.${marketId}` },
        ({ new: row }) => {
          const m = row as Record<string, unknown>;
          if (m.status !== 'resolved') return;
          onEvent({
            type: 'resolved',
            market_id: marketId,
            winning_bin_id: (m.winning_bin_id as string | null) ?? null,
            reopen_price:
              m.reopen_price === null || m.reopen_price === undefined
                ? null
                : Number(m.reopen_price),
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [marketId, onEvent]);
}

export function useUserEvents(userId: string, onEvent: Handler<UserEvent>): void {
  useEffect(() => {
    if (!supabaseConfigured) {
      return fallbackUser(userId).subscribe(onEvent);
    }
    const supabase = getBrowserSupabase();
    if (!supabase) return fallbackUser(userId).subscribe(onEvent);

    const channel: RealtimeChannel = supabase
      .channel(`user:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${userId}`,
        },
        ({ new: row }) => {
          const w = row as Record<string, unknown>;
          if (w.account !== 'user_wallet') return;
          onEvent({
            type: 'wallet',
            user_id: userId,
            balance_micro: Number(w.balance_micro ?? 0),
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, onEvent]);
}
