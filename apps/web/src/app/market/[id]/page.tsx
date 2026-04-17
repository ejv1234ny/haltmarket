import { notFound } from 'next/navigation';
import { BetForm } from '@/components/bet-form';
import { BinLadder } from '@/components/bin-ladder';
import { Countdown } from '@/components/countdown';
import { MarketPoolLive } from '@/components/market-pool-live';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMarketById, MOCK_WALLET } from '@/lib/mocks/fixtures';
import { formatPrice } from '@/lib/format';

const badgeVariantFor = {
  open: 'live',
  locked: 'locked',
  resolved: 'resolved',
  refunded: 'refunded',
} as const;

export default function MarketPage({ params }: { params: { id: string } }) {
  const market = getMarketById(params.id);
  if (!market) notFound();

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-3xl font-bold tracking-tight">{market.symbol}</h1>
          <Badge variant={badgeVariantFor[market.status]}>{market.status}</Badge>
        </div>
        <p className="text-sm text-neutral-400">
          LUDP halt at {formatPrice(market.last_price)} · pool <MarketPoolLive market={market} />
          {market.status === 'open' && (
            <>
              {' '}
              · closes in <Countdown iso={market.closes_at} className="font-mono text-neutral-200" />
            </>
          )}
          {market.status === 'resolved' && market.reopen_price && (
            <> · reopened {formatPrice(market.reopen_price)}</>
          )}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,360px)]">
        <Card>
          <CardHeader>
            <CardTitle>Ladder · 20 bins</CardTitle>
          </CardHeader>
          <CardContent>
            <BinLadder market={market} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <BetForm
            market={market}
            walletBalanceMicro={MOCK_WALLET.balance_micro}
            disabled={market.status !== 'open'}
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">How this works</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-neutral-400">
              Parimutuel pool over a log-spaced price ladder. Your predicted price maps to one of the 20 bins.
              If the official reopen lands in your bin, you split the pool (minus a 5% fee) with other winners,
              pro-rata to your stake. Unresolved markets refund in full.
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
