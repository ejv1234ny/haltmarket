import { notFound } from 'next/navigation';
import { BetForm } from '@/components/bet-form';
import { Countdown } from '@/components/countdown';
import { LadderDisclosure } from '@/components/ladder-disclosure';
import { MarketPoolLive } from '@/components/market-pool-live';
import { ResolutionBreakdown } from '@/components/resolution-breakdown';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMarketById, MOCK_BETS, MOCK_PAYOUTS, MOCK_USER, MOCK_WALLET } from '@/lib/mocks/fixtures';
import { formatPrice, formatUsd } from '@/lib/format';
import { supabaseConfigured } from '@/lib/env';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  getMarket,
  getUserBetForMarket,
  getUserPayoutForBet,
  getUserWallet,
} from '@/lib/markets/queries';
import type { MockBet, MockMarket, MockPayout } from '@/lib/mocks/types';

export const dynamic = 'force-dynamic';

const badgeVariantFor = {
  open: 'live',
  locked: 'locked',
  resolved: 'resolved',
  refunded: 'refunded',
} as const;

interface Loaded {
  market: MockMarket;
  bet: MockBet | null;
  payout: MockPayout | null;
  walletBalanceMicro: number;
}

async function loadMarketPageData(id: string): Promise<Loaded | null> {
  if (!supabaseConfigured) {
    const market = getMarketById(id);
    if (!market) return null;
    const bet = MOCK_BETS.find((b) => b.market_id === market.id && b.user_id === MOCK_USER.id) ?? null;
    const payout = bet ? MOCK_PAYOUTS.find((p) => p.bet_id === bet.id) ?? null : null;
    return { market, bet, payout, walletBalanceMicro: MOCK_WALLET.balance_micro };
  }
  const supabase = getServerSupabase();
  if (!supabase) return null;
  const market = await getMarket(supabase, id);
  if (!market) return null;

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id ?? null;

  if (!userId) {
    return { market, bet: null, payout: null, walletBalanceMicro: 0 };
  }

  const [bet, wallet] = await Promise.all([
    getUserBetForMarket(supabase, userId, market.id),
    getUserWallet(supabase, userId),
  ]);
  const payout = bet ? await getUserPayoutForBet(supabase, bet.id) : null;
  if (bet) bet.symbol = market.symbol;

  return { market, bet, payout, walletBalanceMicro: wallet.balance_micro };
}

export default async function MarketPage({ params }: { params: { id: string } }) {
  const data = await loadMarketPageData(params.id);
  if (!data) notFound();
  const { market, bet: yourBet, payout: yourPayout, walletBalanceMicro } = data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-3xl font-bold tracking-tight">{market.symbol}</h1>
          <Badge variant={badgeVariantFor[market.status]}>{market.status}</Badge>
          <Badge variant="outline">{market.reason_code}</Badge>
        </div>
        <p className="text-sm text-neutral-400">
          Halt at {formatPrice(market.last_price)} · pool <MarketPoolLive market={market} /> · fee{' '}
          {(market.fee_bps / 100).toFixed(0)}% · closest bonus {(market.closest_bonus_bps / 100).toFixed(0)}%
          {market.status === 'open' && (
            <>
              {' '}
              · closes in <Countdown iso={market.closes_at} className="font-mono text-neutral-200" />
            </>
          )}
          {market.status === 'resolved' && market.reopen_price && (
            <> · reopened {formatPrice(market.reopen_price)}</>
          )}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,360px)]">
        <div className="flex flex-col gap-4">
          {market.status === 'resolved' && yourBet && yourPayout && (
            <ResolutionBreakdown
              market={market}
              bet={yourBet}
              binAmountMicro={yourPayout.bin_amount_micro}
              bonusAmountMicro={yourPayout.bonus_amount_micro}
            />
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">How this works</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-neutral-400">
              Type the price you think this stock reopens at. Your guess maps to a zone (one of 20 log-spaced bins).
              If the reopen lands in your zone, you split{' '}
              <span className="font-mono">
                {(100 - market.fee_bps / 100 - market.closest_bonus_bps / 100).toFixed(0)}%
              </span>{' '}
              of the pool with the other zone winners — pro-rata to your stake. The single closest guess across the
              whole market also wins a{' '}
              <span className="font-mono">{(market.closest_bonus_bps / 100).toFixed(0)}%</span> bonus. Unresolved
              markets refund in full.
            </CardContent>
          </Card>
          <LadderDisclosure market={market} />
        </div>

        <div className="flex flex-col gap-4">
          <BetForm
            market={market}
            walletBalanceMicro={walletBalanceMicro}
            disabled={market.status !== 'open'}
          />
          {market.status === 'resolved' && market.reopen_price && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Reopen</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm text-neutral-300">
                <div>
                  Reopen price: <span className="font-mono text-neutral-100">{formatPrice(market.reopen_price)}</span>
                </div>
                {market.closest_bonus_winner_user_id && market.closest_bonus_amount_micro !== null && (
                  <div className="text-xs text-sky-300">
                    Closest-to-pin bonus {formatUsd(market.closest_bonus_amount_micro)} awarded.
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
