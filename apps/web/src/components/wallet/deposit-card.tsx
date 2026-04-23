'use client';

import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUsd } from '@/lib/format';
import type { DepositRow } from '@/lib/markets/queries';

interface Props {
  address: string | null;
  deposits: DepositRow[];
}

export function DepositCard({ address, deposits }: Props) {
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* no-op */
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deposit USDC (Base)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {!address && (
          <p className="text-neutral-400">
            Your deposit address is being provisioned. This usually takes a few seconds after sign-in.
          </p>
        )}

        {address && (
          <>
            <div className="flex flex-col items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-4">
              <QRCodeSVG
                value={address}
                size={160}
                bgColor="#0a0a0a"
                fgColor="#e5e5e5"
                data-testid="deposit-qr"
              />
              <code
                className="break-all text-center font-mono text-xs text-neutral-300"
                data-testid="deposit-address"
              >
                {address}
              </code>
              <Button variant="outline" size="sm" onClick={copyAddress}>
                {copied ? 'Copied' : 'Copy address'}
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              Send USDC on <span className="text-neutral-300">Base</span> only.
              Lifetime alpha cap: <span className="text-neutral-300">$250</span>.
              Confirmations typically complete within 10 seconds.
            </p>
          </>
        )}

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            Recent deposits
          </div>
          {deposits.length === 0 ? (
            <p className="text-xs text-neutral-400">No deposits yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-900">
              {deposits.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2 text-xs">
                  <div className="flex flex-col">
                    <span className="font-mono text-neutral-200">{formatUsd(d.amount_micro)}</span>
                    <span className="text-neutral-500">{new Date(d.created_at).toLocaleString()}</span>
                  </div>
                  <span
                    className={
                      d.status === 'confirmed'
                        ? 'font-mono text-emerald-300'
                        : d.status === 'pending'
                          ? 'font-mono text-amber-300'
                          : 'font-mono text-neutral-400'
                    }
                  >
                    {d.status}
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
