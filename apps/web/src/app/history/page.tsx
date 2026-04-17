import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MOCK_BETS, MOCK_PAYOUTS } from '@/lib/mocks/fixtures';
import { formatPrice, formatUsd } from '@/lib/format';

export default function HistoryPage() {
  const payoutByBet = new Map(MOCK_PAYOUTS.map((p) => [p.bet_id, p]));

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">History</h1>
        <p className="text-sm text-neutral-400">Every bet you&apos;ve placed. Live markets appear here in real time.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Your bets</CardTitle>
        </CardHeader>
        <CardContent>
          {MOCK_BETS.length === 0 ? (
            <p className="text-sm text-neutral-400">No bets yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-900">
              {MOCK_BETS.map((bet) => {
                const payout = payoutByBet.get(bet.id);
                return (
                  <li key={bet.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                    <div className="flex min-w-0 flex-col">
                      <div className="flex items-center gap-2">
                        <Link href={`/market/${bet.market_id}`} className="font-mono font-semibold">
                          {bet.symbol}
                        </Link>
                        <Badge variant={bet.status === 'settled' ? 'resolved' : 'live'}>{bet.status}</Badge>
                      </div>
                      <span className="text-xs text-neutral-500">
                        guessed {formatPrice(bet.predicted_price)} · {new Date(bet.placed_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="font-mono text-neutral-200">{formatUsd(bet.stake_micro)}</span>
                      {payout && (
                        <span
                          className="font-mono text-xs text-emerald-300"
                          data-testid={`payout-${bet.id}`}
                        >
                          paid {formatUsd(payout.amount_micro)}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
