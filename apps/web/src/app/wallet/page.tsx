import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WalletBalance } from '@/components/wallet-balance';
import { formatUsd } from '@/lib/format';
import { MOCK_LEDGER, MOCK_USER, MOCK_WALLET } from '@/lib/mocks/fixtures';
import { supabaseConfigured } from '@/lib/env';
import { getServerSupabase } from '@/lib/supabase/server';
import { getUserWallet, listLedgerEntries } from '@/lib/markets/queries';
import type { MockLedgerEntry, MockWallet } from '@/lib/mocks/types';

export const dynamic = 'force-dynamic';

async function loadWallet(): Promise<{
  wallet: MockWallet;
  ledger: MockLedgerEntry[];
  signedIn: boolean;
}> {
  if (!supabaseConfigured) {
    return { wallet: MOCK_WALLET, ledger: MOCK_LEDGER, signedIn: true };
  }
  const supabase = getServerSupabase();
  if (!supabase) {
    return { wallet: { user_id: '', currency: 'USDC', balance_micro: 0 }, ledger: [], signedIn: false };
  }
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) {
    return { wallet: { user_id: '', currency: 'USDC', balance_micro: 0 }, ledger: [], signedIn: false };
  }
  const [wallet, ledger] = await Promise.all([
    getUserWallet(supabase, userId),
    listLedgerEntries(supabase, userId),
  ]);
  return { wallet, ledger, signedIn: true };
}

export default async function WalletPage() {
  const { wallet, ledger, signedIn } = await loadWallet();
  const userId = signedIn ? wallet.user_id || MOCK_USER.id : MOCK_USER.id;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Wallet</h1>
        <p className="text-sm text-neutral-400">USDC balance, recent ledger entries, and deposit controls.</p>
      </header>

      {!signedIn && (
        <Card className="border-amber-700/40 bg-amber-950/20">
          <CardContent className="p-4 text-xs text-amber-200">
            Sign in to see your wallet balance and ledger history.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-neutral-400">Available balance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <WalletBalance userId={userId} initialMicro={wallet.balance_micro} />
          <div className="flex gap-2">
            {/* Deposit / withdrawal land in a follow-up; alpha runs on play balance. */}
            <Button variant="primary" disabled>
              Deposit (coming soon)
            </Button>
            <Button variant="outline" disabled>
              Withdraw (coming soon)
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent ledger</CardTitle>
        </CardHeader>
        <CardContent>
          {ledger.length === 0 ? (
            <p className="text-sm text-neutral-400">No ledger entries yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-900">
              {ledger.map((entry) => {
                const positive = entry.amount_micro >= 0;
                return (
                  <li key={entry.id} className="flex items-center justify-between py-3 text-sm">
                    <div className="flex flex-col">
                      <span className="font-medium capitalize">{entry.reason.replace(/_/g, ' ')}</span>
                      <span className="text-xs text-neutral-500">
                        {new Date(entry.created_at).toLocaleString()}
                      </span>
                    </div>
                    <span
                      className={
                        positive ? 'font-mono text-emerald-300' : 'font-mono text-neutral-400'
                      }
                    >
                      {positive ? '+' : ''}
                      {formatUsd(entry.amount_micro)}
                    </span>
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
