'use client';

import { useEffect, useState } from 'react';
import type { MockMarket } from '@/lib/mocks/types';
import { formatUsd } from '@/lib/format';
import { subscribeMarketChannel } from '@/lib/realtime/market-channel';

export function MarketPoolLive({ market }: { market: MockMarket }) {
  const [pool, setPool] = useState(market.total_pool_micro);

  useEffect(() => {
    const unsub = subscribeMarketChannel(market.id, (ev) => {
      setPool(ev.new_total_pool_micro);
    });
    return unsub;
  }, [market.id]);

  return (
    <span className="font-mono text-neutral-100" data-testid="pool-total">
      {formatUsd(pool)}
    </span>
  );
}
