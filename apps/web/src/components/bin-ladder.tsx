'use client';

import { useEffect, useState } from 'react';
import type { MockMarket } from '@/lib/mocks/types';
import { formatPrice, formatUsd } from '@/lib/format';
import { marketChannel } from '@/lib/mocks/realtime';
import { cn } from '@/lib/utils';

export function BinLadder({ market }: { market: MockMarket }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsub = marketChannel(market.id).subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [market.id]);

  const max = Math.max(1, ...market.bins.map((b) => b.stake_micro));

  return (
    <div className="flex flex-col gap-1" data-testid="bin-ladder">
      {market.bins
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
