'use client';

import { useEffect, useState } from 'react';
import type { MockMarket } from '@/lib/mocks/types';
import { formatUsd } from '@/lib/format';
import { marketChannel } from '@/lib/mocks/realtime';

export function MarketPoolLive({ market }: { market: MockMarket }) {
  const [pool, setPool] = useState(market.total_pool_micro);

  useEffect(() => {
    const unsub = marketChannel(market.id).subscribe((ev) => {
      if (ev.type === 'bin_delta') setPool(ev.total_pool_micro);
    });
    return unsub;
  }, [market.id]);

  return (
    <span className="font-mono text-neutral-100" data-testid="pool-total">
      {formatUsd(pool)}
    </span>
  );
}
