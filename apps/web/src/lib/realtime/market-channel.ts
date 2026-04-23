'use client';

import { getBrowserSupabase } from '../supabase/browser';
import { supabaseConfigured } from '../env';
import { marketChannel as mockMarketChannel } from '../mocks/realtime';

export interface BinDeltaEvent {
  type: 'bin_delta';
  market_id: string;
  bin_id: string;
  bin_idx?: number;
  new_stake_micro: number;
  new_total_pool_micro: number;
}

type Listener = (ev: BinDeltaEvent) => void;

/**
 * Subscribe to pool/bin updates for a market.
 *
 * Real mode: Supabase broadcast channel `markets:{id}` with event `bin_delta`,
 * which the place-bet edge function publishes after a successful bet.
 *
 * Mock mode: reuses the in-memory mock channel that the bet-form pokes in
 * demo/test builds (no Supabase configured).
 *
 * Returns an unsubscribe fn.
 */
export function subscribeMarketChannel(marketId: string, onEvent: Listener): () => void {
  if (!supabaseConfigured) {
    return mockMarketChannel(marketId).subscribe((ev) => {
      if (ev.type !== 'bin_delta') return;
      onEvent({
        type: 'bin_delta',
        market_id: marketId,
        bin_id: `mock-${ev.bin_idx}`,
        bin_idx: ev.bin_idx,
        new_stake_micro: 0,
        new_total_pool_micro: ev.total_pool_micro,
      });
    });
  }

  const supabase = getBrowserSupabase();
  if (!supabase) return () => {};

  const ch = supabase.channel(`markets:${marketId}`, {
    config: { broadcast: { self: true } },
  });
  ch.on('broadcast', { event: 'bin_delta' }, ({ payload }) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    onEvent({
      type: 'bin_delta',
      market_id: marketId,
      bin_id: String(p.bin_id ?? ''),
      new_stake_micro: Number(p.new_stake_micro ?? 0),
      new_total_pool_micro: Number(p.new_total_pool_micro ?? 0),
    });
  });
  ch.subscribe();

  return () => {
    supabase.removeChannel(ch);
  };
}
