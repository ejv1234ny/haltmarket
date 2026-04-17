'use client';

import { useState } from 'react';
import type { MockBet, MockMarket } from '@/lib/mocks/types';
import { formatPrice, formatUsd } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ADR-0002 Phase 7 deliverable: "You won $Z.ZZ" headline with an expandable
// breakdown of the zone share vs closest-to-the-pin bonus.
export function ResolutionBreakdown({
  market,
  bet,
  binAmountMicro,
  bonusAmountMicro,
}: {
  market: MockMarket;
  bet: MockBet;
  binAmountMicro: number;
  bonusAmountMicro: number | null;
}) {
  const [open, setOpen] = useState(false);
  const total = binAmountMicro + (bonusAmountMicro ?? 0);
  const stake = bet.stake_micro;
  const net = total - stake;

  return (
    <Card data-testid="resolution-breakdown">
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between">
          <span>You won {formatUsd(total)}</span>
          <span className="font-mono text-xs text-neutral-500">
            {net >= 0 ? '+' : ''}
            {formatUsd(net)} net on {formatUsd(stake)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-neutral-400">
          Reopen printed at {market.reopen_price ? formatPrice(market.reopen_price) : '—'}. Your guess was{' '}
          {formatPrice(bet.predicted_price)}.
        </p>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="self-start text-xs font-medium text-neutral-400 underline-offset-2 hover:text-neutral-100 hover:underline"
          data-testid="breakdown-toggle"
        >
          {open ? 'Hide breakdown' : 'Show breakdown'}
        </button>
        {open && (
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-neutral-400">Zone share</dt>
            <dd className="text-right font-mono text-emerald-300" data-testid="breakdown-bin">
              {formatUsd(binAmountMicro)}
            </dd>
            {bonusAmountMicro !== null && bonusAmountMicro > 0 && (
              <>
                <dt className="text-neutral-400">Closest-to-pin bonus</dt>
                <dd className="text-right font-mono text-sky-300" data-testid="breakdown-bonus">
                  {formatUsd(bonusAmountMicro)}
                </dd>
              </>
            )}
            <dt className="text-neutral-400">Stake</dt>
            <dd className="text-right font-mono text-neutral-400">-{formatUsd(stake)}</dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
