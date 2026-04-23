'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatUsd, usdToMicro } from '@/lib/format';
import type { WithdrawalRow } from '@/lib/markets/queries';
import {
  requestWithdrawal,
  withdrawalMessageFor,
  type WithdrawalErrorCode,
} from '@/lib/markets/request-withdrawal';

interface Props {
  walletBalanceMicro: number;
  withdrawals: WithdrawalRow[];
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MIN_USD = 5;

export function WithdrawCard({ walletBalanceMicro, withdrawals }: Props) {
  const [amountUsd, setAmountUsd] = useState<string>('');
  const [destination, setDestination] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitted, setSubmitted] = useState<boolean>(false);

  const amount = Number.parseFloat(amountUsd);
  const amountMicro = Number.isFinite(amount) ? usdToMicro(amount) : 0;
  const validAddress = ADDRESS_RE.test(destination);
  const hasBalance = amountMicro > 0 && amountMicro <= walletBalanceMicro;
  const aboveMin = amount >= MIN_USD;
  const canSubmit =
    !submitting && Number.isFinite(amount) && aboveMin && validAddress && hasBalance;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      if (!aboveMin) return setError(`Minimum withdrawal is $${MIN_USD}.`);
      if (!validAddress) return setError('Enter a valid Base address (0x…).');
      if (!hasBalance) return setError('Amount exceeds wallet balance.');
      return;
    }
    setError(null);
    setSubmitting(true);
    const res = await requestWithdrawal({
      amountMicro: BigInt(amountMicro),
      destinationAddress: destination,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(withdrawalMessageFor(res.code as WithdrawalErrorCode));
      return;
    }
    setSubmitted(true);
    setAmountUsd('');
    setDestination('');
    // Parent page re-fetches pending withdrawals on next navigation; a manual
    // refresh here keeps the UX simple without adding realtime wiring.
    setTimeout(() => window.location.reload(), 500);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdraw USDC (Base)</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3 text-sm" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1.5">
            <span className="text-neutral-400">Amount (USDC)</span>
            <Input
              type="number"
              min={MIN_USD}
              step="1"
              inputMode="decimal"
              value={amountUsd}
              onChange={(e) => setAmountUsd(e.target.value)}
              placeholder={`min $${MIN_USD}`}
              data-testid="withdraw-amount"
            />
            <span className="text-xs text-neutral-500">
              Balance: {formatUsd(walletBalanceMicro)}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-neutral-400">Destination address</span>
            <Input
              type="text"
              value={destination}
              onChange={(e) => setDestination(e.target.value.trim())}
              placeholder="0x…"
              data-testid="withdraw-address"
            />
            <span className="text-xs text-neutral-500">
              Base Mainnet only. Double-check the address — on-chain sends are final.
            </span>
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
          {submitted && !error && (
            <p className="text-xs text-emerald-300">
              Withdrawal requested. Admin processes daily; tx hash lands here on confirm.
            </p>
          )}

          <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="withdraw-submit">
            {submitting ? 'Submitting…' : 'Request withdrawal'}
          </Button>
          <p className="text-xs text-neutral-500">
            Withdrawals are processed in daily batches. Expected completion: within 24 hours.
          </p>
        </form>

        <div className="mt-5">
          <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            Recent withdrawals
          </div>
          {withdrawals.length === 0 ? (
            <p className="text-xs text-neutral-400">No withdrawals yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-900">
              {withdrawals.map((w) => (
                <li key={w.id} className="flex items-center justify-between py-2 text-xs">
                  <div className="flex flex-col">
                    <span className="font-mono text-neutral-200">
                      {formatUsd(w.amount_micro)} → {w.destination_address?.slice(0, 10)}…
                    </span>
                    <span className="text-neutral-500">
                      {new Date(w.created_at).toLocaleString()}
                    </span>
                  </div>
                  <span
                    className={
                      w.status === 'confirmed'
                        ? 'font-mono text-emerald-300'
                        : w.status === 'pending'
                          ? 'font-mono text-amber-300'
                          : 'font-mono text-red-300'
                    }
                  >
                    {w.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
