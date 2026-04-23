import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MOCK_BETS, MOCK_PAYOUTS } from '@/lib/mocks/fixtures';
import { formatPrice, formatUsd } from '@/lib/format';
import { supabaseConfigured } from '@/lib/env';
import { getServerSupabase } from '@/lib/supabase/server';
import { listUserBets, listUserPayouts } from '@/lib/markets/queries';
import type { MockBet, MockPayout } from '@/lib/mocks/types';

export const dynamic = 'force-dynamic';

async function loadHistory(): Promise<{
  bets: MockBet[];
  payouts: MockPayout[];
  signedIn: boolean;
}> {
  if (!supabaseConfigured) return { bets: MOCK_BETS, payouts: MOCK_PAYOUTS, signedIn: true };
  const supabase = getServerSupabase();
  if (!supabase) return { bets: [], payouts: [], signedIn: false };
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return { bets: [], payouts: [], signedIn: false };
  const [bets, payouts] = await Promise.all([
    listUserBets(supabase, userId),
    listUserPayouts(supabase, userId),
  ]);
  return { bets, payouts, signedIn: true };
}

export default async function HistoryPage() {
  const { bets, payouts, signedIn } = await loadHistory();
  const payoutByBet = new Map(payouts.map((p) => [p.bet_id, p]));

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">History</h1>
        <p className="text-sm text-neutral-400">Every bet you&apos;ve placed. Live markets appear here in real time.</p>
      </header>

      {!signedIn && (
        <Card className="border-amber-700/40 bg-amber-950/20">
          <CardContent className="p-4 text-xs text-amber-200">
            Sign in to see your bet history.
          </CardContent>
        </Card>
      )}

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
                          paid {formatUsd(payout.bin_amount_micro + (payout.bonus_amount_micro ?? 0))}
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
