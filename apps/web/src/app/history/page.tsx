import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listBetsForUser, listPayoutsForBets } from '@/lib/data/bets';
import { formatPrice, formatUsd } from '@/lib/format';
import { getSessionUser } from '@/lib/session';

export default async function HistoryPage() {
  const user = await getSessionUser();
  const bets = await listBetsForUser(user.id);
  const payouts = await listPayoutsForBets(bets.map((b) => b.id));

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
          {bets.length === 0 ? (
            <p className="text-sm text-neutral-400">No bets yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-900">
              {bets.map((bet) => {
                const payout = payouts.get(bet.id);
                const total = payout
                  ? payout.bin_amount_micro + (payout.bonus_amount_micro ?? 0)
                  : 0;
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
                      {payout && total > 0 && (
                        <span
                          className="font-mono text-xs text-emerald-300"
                          data-testid={`payout-${bet.id}`}
                        >
                          paid {formatUsd(total)}
                          {payout.bonus_amount_micro ? (
                            <span className="ml-1 text-sky-300">
                              (incl. {formatUsd(payout.bonus_amount_micro)} bonus)
                            </span>
                          ) : null}
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
