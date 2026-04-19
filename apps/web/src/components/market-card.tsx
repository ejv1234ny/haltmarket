import Link from 'next/link';
import type { MockMarket } from '@/lib/mocks/types';
import { formatPrice, formatUsd } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Countdown } from '@/components/countdown';

const badgeVariantFor = {
  open: 'live',
  locked: 'locked',
  resolved: 'resolved',
  refunded: 'refunded',
} as const;

export function MarketCard({ market }: { market: MockMarket }) {
  return (
    <Link href={`/market/${market.id}`} aria-label={`${market.symbol} market`}>
      <Card className="transition hover:border-neutral-700">
        <CardContent className="flex items-center justify-between gap-4 p-5">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-semibold">{market.symbol}</span>
              <Badge variant={badgeVariantFor[market.status]}>{market.status}</Badge>
            </div>
            <div className="text-xs text-neutral-500">
              halt @ {formatPrice(market.last_price)} · reason {market.reason_code}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            <div className="text-sm font-semibold text-neutral-100">
              {formatUsd(market.total_pool_micro, { compact: true })}
              <span className="ml-1 text-xs font-normal text-neutral-500">pool</span>
            </div>
            <div className="text-xs text-neutral-400">
              {market.status === 'open' ? (
                <>
                  closes in <Countdown iso={market.closes_at} className="font-mono text-neutral-200" />
                </>
              ) : market.status === 'resolved' && market.reopen_price ? (
                <>reopened {formatPrice(market.reopen_price)}</>
              ) : (
                <>{market.status}</>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
