import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MOCK_LEADERBOARD, MOCK_USER } from '@/lib/mocks/fixtures';
import { formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import { supabaseConfigured } from '@/lib/env';
import { getServerSupabase } from '@/lib/supabase/server';
import { getLeaderboard, type LeaderboardRow } from '@/lib/markets/queries';
import type { MockLeaderboardRow } from '@/lib/mocks/types';

export const dynamic = 'force-dynamic';

async function loadLeaderboard(): Promise<{
  rows: MockLeaderboardRow[] | LeaderboardRow[];
  currentUserId: string;
}> {
  if (!supabaseConfigured) {
    return { rows: MOCK_LEADERBOARD, currentUserId: MOCK_USER.id };
  }
  const supabase = getServerSupabase();
  if (!supabase) return { rows: [], currentUserId: '' };
  const [{ data: userData }, rows] = await Promise.all([
    supabase.auth.getUser(),
    getLeaderboard(supabase, 50),
  ]);
  return { rows, currentUserId: userData.user?.id ?? '' };
}

export default async function LeaderboardPage() {
  const { rows, currentUserId } = await loadLeaderboard();

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Leaderboard</h1>
        <p className="text-sm text-neutral-400">Rolling 30-day net P&amp;L across all resolved markets.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Top traders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-neutral-400">No leaderboard data yet — resolve some markets first.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-5 py-3 text-left">#</th>
                  <th className="px-5 py-3 text-left">Handle</th>
                  <th className="px-5 py-3 text-right">Staked</th>
                  <th className="px-5 py-3 text-right">Net P&amp;L</th>
                  <th className="hidden px-5 py-3 text-right sm:table-cell">W/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-900">
                {rows.map((row) => {
                  const isMe = row.user_id === currentUserId;
                  const positive = row.net_pnl_micro >= 0;
                  return (
                    <tr key={row.user_id} className={cn(isMe && 'bg-neutral-900/60')}>
                      <td className="px-5 py-3 font-mono text-neutral-400">{row.rank}</td>
                      <td className="px-5 py-3">
                        <span className="font-medium">{row.handle}</span>
                        {isMe && <span className="ml-2 text-xs text-emerald-300">you</span>}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-neutral-300">
                        {formatUsd(row.total_staked_micro, { compact: true })}
                      </td>
                      <td
                        className={cn(
                          'px-5 py-3 text-right font-mono',
                          positive ? 'text-emerald-300' : 'text-red-300',
                        )}
                      >
                        {positive ? '+' : ''}
                        {formatUsd(row.net_pnl_micro, { compact: true })}
                      </td>
                      <td className="hidden px-5 py-3 text-right font-mono text-neutral-400 sm:table-cell">
                        {row.wins}/{row.bets}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
