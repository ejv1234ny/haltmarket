'use client';

import { useCallback, useState } from 'react';
import type { Bin, Market } from '@/lib/data';
import { useMarketEvents } from '@/lib/data';
import { formatPrice, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

export function BinLadder({ market }: { market: Market }) {
  // Keep a local mutable copy so realtime deltas rerender without touching
  // the server-rendered prop. Stake deltas only hit the matching bin id.
  const [bins, setBins] = useState<Bin[]>(() => market.bins.map((b) => ({ ...b })));

  useMarketEvents(
    market.id,
    useCallback((ev) => {
      if (ev.type !== 'bin_delta') return;
      setBins((prev) =>
        prev.map((b) => (b.id === ev.bin_id ? { ...b, stake_micro: ev.new_stake_micro } : b)),
      );
    }, []),
  );

  const max = Math.max(1, ...bins.map((b) => b.stake_micro));

  return (
    <div className="flex flex-col gap-1" data-testid="bin-ladder">
      {bins
        .slice()
        .sort((a, b) => b.idx - a.idx)
        .map((bin) => {
          const pct = (bin.stake_micro / max) * 100;
          const isWinner = bin.id === market.winning_bin_id;
          return (
            <div
              key={bin.id}
              className={cn(
                'flex items-center gap-3 rounded-md border border-neutral-800/60 bg-neutral-950/40 px-3 py-2 text-xs',
                isWinner && 'border-emerald-700 bg-emerald-950/30',
              )}
            >
              <span className="w-8 font-mono text-neutral-500">#{bin.idx + 1}</span>
              <span className="w-32 font-mono text-neutral-300">
                {formatPrice(bin.low_price)}–{formatPrice(bin.high_price)}
              </span>
              <div className="relative flex-1 overflow-hidden rounded-full bg-neutral-900">
                <div
                  className={cn(
                    'h-2 rounded-full bg-neutral-600',
                    isWinner && 'bg-emerald-500',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-20 text-right font-mono text-neutral-400">{formatUsd(bin.stake_micro, { compact: true })}</span>
            </div>
          );
        })}
    </div>
  );
}
