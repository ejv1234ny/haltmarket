import type { MockBin } from './mocks/types';

// Generate 20 log-spaced bins from 0.5 × last_price to 2.0 × last_price.
// Mirrors the Phase 3 ladder spec in AGENTS.md; kept here so the mocked
// markets match what Codespace A will produce server-side.
export function buildLadder(marketId: string, lastPrice: number): MockBin[] {
  const bins: MockBin[] = [];
  const low = lastPrice * 0.5;
  const high = lastPrice * 2.0;
  const steps = 20;
  const logLow = Math.log(low);
  const logHigh = Math.log(high);
  const step = (logHigh - logLow) / steps;
  for (let i = 0; i < steps; i += 1) {
    const binLow = Math.max(0.01, Math.exp(logLow + step * i));
    const binHigh = Math.exp(logLow + step * (i + 1));
    bins.push({
      id: `${marketId}-bin-${i}`,
      market_id: marketId,
      idx: i,
      low_price: round2(binLow),
      high_price: round2(binHigh),
      stake_micro: 0,
    });
  }
  return bins;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ADR-0002: the bet form accepts a *price*, not a bin. This is the
// client-side mapping from predicted price → winning bin. Returns null when
// the price falls outside the ladder (tail-bin handling belongs to the
// resolver — Phase 5 — not the UI).
export function resolveBin(price: number, bins: MockBin[]): MockBin | null {
  if (!Number.isFinite(price) || price <= 0 || bins.length === 0) return null;
  const sorted = [...bins].sort((a, b) => a.idx - b.idx);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (price < first.low_price) return first;
  if (price >= last.high_price) return last;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = sorted[mid]!;
    if (price < b.low_price) hi = mid - 1;
    else if (price >= b.high_price) lo = mid + 1;
    else return b;
  }
  return null;
}

export function impliedPayoutMultiple(
  binStakeMicro: number,
  totalPoolMicro: number,
  addedStakeMicro: number,
  feeBps: number,
): number {
  const newBinStake = binStakeMicro + addedStakeMicro;
  const newTotal = totalPoolMicro + addedStakeMicro;
  if (newBinStake === 0) return 0;
  const feeFrac = feeBps / 10_000;
  const payoutPool = newTotal * (1 - feeFrac);
  return payoutPool / newBinStake;
}
