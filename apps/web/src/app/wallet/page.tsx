import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WalletBalance } from '@/components/wallet-balance';
import { getWalletForUser, listRecentLedger } from '@/lib/data/wallet';
import { formatUsd } from '@/lib/format';
import { getSessionUser } from '@/lib/session';

export default async function WalletPage() {
  const user = await getSessionUser();
  const [wallet, ledger] = await Promise.all([
    getWalletForUser(user.id),
    listRecentLedger(user.id),
  ]);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Wallet</h1>
        <p className="text-sm text-neutral-400">USDC balance, recent ledger entries, and deposit controls.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-neutral-400">Available balance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <WalletBalance userId={user.id} initialMicro={wallet.balance_micro} />
          <div className="flex gap-2">
            {/* TODO(phase-8): wire to StubProvider `initiate-deposit` / `initiate-withdrawal` edge functions. */}
            <Button variant="primary" disabled>
              Deposit (Phase 8)
            </Button>
            <Button variant="outline" disabled>
              Withdraw (Phase 8)
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
            <p className="text-sm text-neutral-400">No ledger activity yet.</p>
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
