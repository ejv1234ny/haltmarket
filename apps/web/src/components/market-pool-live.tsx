'use client';

import { useCallback, useState } from 'react';
import type { Market } from '@/lib/data';
import { useMarketEvents } from '@/lib/data';
import { formatUsd } from '@/lib/format';

export function MarketPoolLive({ market }: { market: Market }) {
  const [pool, setPool] = useState(market.total_pool_micro);

  useMarketEvents(
    market.id,
    useCallback((ev) => {
      if (ev.type === 'bin_delta') setPool(ev.new_total_pool_micro);
    }, []),
  );

  return (
    <span className="font-mono text-neutral-100" data-testid="pool-total">
      {formatUsd(pool)}
    </span>
  );
}
