import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WalletBalance } from '@/components/wallet-balance';
import { DepositCard } from '@/components/wallet/deposit-card';
import { WithdrawCard } from '@/components/wallet/withdraw-card';
import { formatUsd } from '@/lib/format';
import { MOCK_LEDGER, MOCK_USER, MOCK_WALLET } from '@/lib/mocks/fixtures';
import { supabaseConfigured } from '@/lib/env';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  getUserWallet,
  getUserWalletAddress,
  listLedgerEntries,
  listUserDeposits,
  listUserWithdrawals,
  type DepositRow,
  type WithdrawalRow,
} from '@/lib/markets/queries';
import type { MockLedgerEntry, MockWallet } from '@/lib/mocks/types';

export const dynamic = 'force-dynamic';

interface Loaded {
  wallet: MockWallet;
  ledger: MockLedgerEntry[];
  deposits: DepositRow[];
  withdrawals: WithdrawalRow[];
  depositAddress: string | null;
  signedIn: boolean;
}

async function loadWallet(): Promise<Loaded> {
  if (!supabaseConfigured) {
    return {
      wallet: MOCK_WALLET,
      ledger: MOCK_LEDGER,
      deposits: [],
      withdrawals: [],
      depositAddress: null,
      signedIn: true,
    };
  }
  const supabase = getServerSupabase();
  if (!supabase) {
    return {
      wallet: { user_id: '', currency: 'USDC', balance_micro: 0 },
      ledger: [],
      deposits: [],
      withdrawals: [],
      depositAddress: null,
      signedIn: false,
    };
  }
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) {
    return {
      wallet: { user_id: '', currency: 'USDC', balance_micro: 0 },
      ledger: [],
      deposits: [],
      withdrawals: [],
      depositAddress: null,
      signedIn: false,
    };
  }
  const [wallet, ledger, deposits, withdrawals, walletAddress] = await Promise.all([
    getUserWallet(supabase, userId),
    listLedgerEntries(supabase, userId),
    listUserDeposits(supabase, userId),
    listUserWithdrawals(supabase, userId),
    getUserWalletAddress(supabase, userId),
  ]);
  return {
    wallet,
    ledger,
    deposits,
    withdrawals,
    depositAddress: walletAddress?.address ?? null,
    signedIn: true,
  };
}

export default async function WalletPage() {
  const { wallet, ledger, deposits, withdrawals, depositAddress, signedIn } =
    await loadWallet();
  const userId = signedIn ? wallet.user_id || MOCK_USER.id : MOCK_USER.id;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Wallet</h1>
        <p className="text-sm text-neutral-400">USDC balance, deposits, withdrawals, and ledger history.</p>
      </header>

      {!signedIn && (
        <Card className="border-amber-700/40 bg-amber-950/20">
          <CardContent className="p-4 text-xs text-amber-200">
            Sign in to see your wallet balance, deposits, and withdrawals.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-neutral-400">Available balance</CardTitle>
        </CardHeader>
        <CardContent>
          <WalletBalance userId={userId} initialMicro={wallet.balance_micro} />
        </CardContent>
      </Card>

      {signedIn && (
        <div className="grid gap-6 md:grid-cols-2">
          <DepositCard address={depositAddress} deposits={deposits} />
          <WithdrawCard walletBalanceMicro={wallet.balance_micro} withdrawals={withdrawals} />
        </div>
      )}

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
