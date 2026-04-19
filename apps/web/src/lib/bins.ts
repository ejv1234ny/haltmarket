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

// ADR-0002: the bet form accepts a *price*, not a bin. The UI maps
// client-side for preview ("your guess lands in bin $X–$Y"); the real
// mapping is server-side at Phase 4 (`place-bet` derives bin_id from
// predicted_price). Returns null for nonsense input; clamps to the
// outermost bin for out-of-range prices so the preview is never empty.
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

// ADR-0002 hybrid math: the main payout pool is gross × (1 − fee_bps − bonus_bps).
// Returns the multiple a new bet of `addedStakeMicro` would earn if its bin won
// (bonus not included — that's at most one user per market).
export function impliedMainPayoutMultiple(
  binStakeMicro: number,
  totalPoolMicro: number,
  addedStakeMicro: number,
  feeBps: number,
  closestBonusBps: number,
): number {
  const newBinStake = binStakeMicro + addedStakeMicro;
  const newTotal = totalPoolMicro + addedStakeMicro;
  if (newBinStake === 0) return 0;
  const mainFrac = 1 - feeBps / 10_000 - closestBonusBps / 10_000;
  const mainPool = newTotal * mainFrac;
  return mainPool / newBinStake;
}

// Potential bonus if this bet ends up being the single closest across the
// market. Doesn't depend on bin crowding — 7% of the gross pool goes to one
// user (ties split equally; UI shows the un-split single-winner case).
export function impliedBonusMicro(
  totalPoolMicro: number,
  addedStakeMicro: number,
  closestBonusBps: number,
): number {
  return Math.floor(((totalPoolMicro + addedStakeMicro) * closestBonusBps) / 10_000);
}
