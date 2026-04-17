'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import type { MockBin, MockMarket } from '@/lib/mocks/types';
import { impliedBonusMicro, impliedMainPayoutMultiple, resolveBin } from '@/lib/bins';
import { formatPrice, formatUsd, microToUsd, usdToMicro } from '@/lib/format';
import { marketChannel, userChannel } from '@/lib/mocks/realtime';
import { MOCK_USER } from '@/lib/mocks/fixtures';

export interface BetFormProps {
  market: MockMarket;
  walletBalanceMicro: number;
  disabled?: boolean;
}

type PlacedBet = {
  bin: MockBin;
  stakeMicro: number;
  predictedPrice: number;
};

export function BetForm({ market, walletBalanceMicro, disabled }: BetFormProps) {
  const [priceInput, setPriceInput] = useState<string>(market.last_price.toFixed(2));
  const [stakeUsd, setStakeUsd] = useState<string>('10');
  const [placed, setPlaced] = useState<PlacedBet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const price = Number.parseFloat(priceInput);
  const stake = Number.parseFloat(stakeUsd);
  const stakeMicro = Number.isFinite(stake) ? usdToMicro(stake) : 0;

  const targetBin = useMemo(() => resolveBin(price, market.bins), [price, market.bins]);

  const mainMultiple = useMemo(() => {
    if (!targetBin || stakeMicro <= 0) return 0;
    return impliedMainPayoutMultiple(
      targetBin.stake_micro,
      market.total_pool_micro,
      stakeMicro,
      market.fee_bps,
      market.closest_bonus_bps,
    );
  }, [targetBin, stakeMicro, market.total_pool_micro, market.fee_bps, market.closest_bonus_bps]);

  const bonusMicro = useMemo(
    () => impliedBonusMicro(market.total_pool_micro, stakeMicro, market.closest_bonus_bps),
    [market.total_pool_micro, stakeMicro, market.closest_bonus_bps],
  );

  const insufficient = stakeMicro > walletBalanceMicro;
  const canSubmit =
    !disabled && Number.isFinite(price) && price > 0 && stakeMicro > 0 && !insufficient && targetBin !== null;

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !targetBin) {
      setError(insufficient ? 'Insufficient balance' : 'Enter a valid price and stake');
      return;
    }
    // TODO(phase-4): POST to the `place-bet` edge function with
    // { market_id, predicted_price, stake_micro, idempotency_key }. The
    // server derives bin_id; the client mapping here is presentational.
    setError(null);
    targetBin.stake_micro += stakeMicro;
    market.total_pool_micro += stakeMicro;
    marketChannel(market.id).publish({
      type: 'bin_delta',
      market_id: market.id,
      bin_idx: targetBin.idx,
      stake_delta_micro: stakeMicro,
      total_pool_micro: market.total_pool_micro,
    });
    userChannel(MOCK_USER.id).publish({
      type: 'wallet',
      user_id: MOCK_USER.id,
      balance_micro: walletBalanceMicro - stakeMicro,
    });
    setPlaced({ bin: targetBin, stakeMicro, predictedPrice: price });
  }

  if (disabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Betting closed</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-neutral-400">
          This market is {market.status}. Payouts settle automatically when the resolver captures the reopen price.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Guess the reopen price</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-400">Predicted reopen price (USD)</span>
            <Input
              type="number"
              step="0.0001"
              min="0.01"
              inputMode="decimal"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              aria-label="predicted reopen price"
              data-testid="price-input"
            />
            <span className="text-xs text-neutral-500" data-testid="bin-preview">
              {targetBin
                ? `Your guess: ${formatPrice(price)} · bin ${formatPrice(targetBin.low_price)}–${formatPrice(targetBin.high_price)}`
                : 'Enter a price to see the zone it lands in.'}
            </span>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-400">Stake (USDC)</span>
            <Input
              type="number"
              step="1"
              min="1"
              inputMode="decimal"
              value={stakeUsd}
              onChange={(e) => setStakeUsd(e.target.value)}
              aria-label="stake usd"
              data-testid="stake-input"
            />
            <span className="text-xs text-neutral-500">
              Wallet: {formatUsd(walletBalanceMicro)} · 10 bets/sec · $1000 per market
            </span>
          </label>

          <Separator />

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs uppercase tracking-wide text-neutral-500">If your zone wins</span>
              <span className="font-mono text-emerald-300" data-testid="payout-estimate">
                {mainMultiple > 0 && Number.isFinite(mainMultiple)
                  ? `≈ ${formatUsd(Math.round(microToUsd(stakeMicro) * mainMultiple * 1_000_000))}`
                  : '—'}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs uppercase tracking-wide text-neutral-500">
                Closest-to-pin bonus ({(market.closest_bonus_bps / 100).toFixed(0)}%)
              </span>
              <span className="font-mono text-sky-300" data-testid="bonus-estimate">
                {bonusMicro > 0 ? `+ ${formatUsd(bonusMicro)}` : '—'}
              </span>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <Button type="submit" variant="primary" size="lg" disabled={!canSubmit} data-testid="place-bet">
            {insufficient ? 'Insufficient balance' : `Place $${Number.isFinite(stake) ? stake : 0} bet`}
          </Button>

          {placed && (
            <div
              className="rounded-md border border-emerald-800/60 bg-emerald-950/30 p-3 text-sm text-emerald-200"
              data-testid="bet-placed"
            >
              Bet placed · your guess {formatPrice(placed.predictedPrice)} · stake {formatUsd(placed.stakeMicro)}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
