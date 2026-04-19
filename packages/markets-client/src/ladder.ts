// Bin ladder — TS mirror of supabase/migrations/0003_markets.sql::compute_bin_ladder.
//
// The SQL function is the source of truth at runtime (called by create_market
// and by find_bin_for_price). This TS copy exists for two reasons:
//
//   1. Unit-testable without a Postgres — fast local feedback loop.
//   2. Client-side preview ("Your guess $X · bin $A–$B") per ADR-0002's UX
//      contract, without round-tripping to DB on every keystroke.
//
// Integration tests assert the two implementations agree across the ladder's
// $0.10–$10,000 price range.

export interface Bin {
  readonly idx: number;
  readonly lowPrice: number;
  readonly highPrice: number;
  readonly isTailLow: boolean;
  readonly isTailHigh: boolean;
}

/**
 * numeric(12,4) upper bound used as the tail-high sentinel.
 * Mirrors the SQL literal so cross-implementation checks match.
 */
export const TAIL_HIGH_MAX = 99999999.9999;

/**
 * Build a 22-bin ladder for a given last_price.
 *   idx 0      → tail-low      [0, 0.5P)
 *   idx 1..20  → log-spaced    low = 0.5P · 4^((i-1)/20), high = 0.5P · 4^(i/20)
 *   idx 21     → tail-high     [2P, TAIL_HIGH_MAX)
 *
 * Values are rounded to 4 decimal places. If two adjacent boundaries collapse
 * (possible only for pathologically small last_price), the bin's high is
 * bumped by 0.0001 so the `low < high` invariant still holds — matching the
 * SQL guard.
 */
export function computeBinLadder(lastPrice: number): Bin[] {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    throw new Error(`computeBinLadder: lastPrice must be positive, got ${lastPrice}`);
  }

  const halfP = lastPrice * 0.5;
  const doubleP = lastPrice * 2.0;
  const ratio = Math.pow(4, 1 / 20); // ≈ 1.071773

  const out: Bin[] = [];

  // idx 0 — tail-low
  out.push(bumpIfFlat({
    idx: 0,
    lowPrice: round4(0),
    highPrice: round4(halfP),
    isTailLow: true,
    isTailHigh: false,
  }));

  // idx 1..20 — log-spaced main bins
  let low = halfP;
  for (let i = 1; i <= 20; i++) {
    const high = low * ratio;
    out.push(
      bumpIfFlat({
        idx: i,
        lowPrice: round4(low),
        highPrice: round4(high),
        isTailLow: false,
        isTailHigh: false,
      }),
    );
    low = high;
  }

  // idx 21 — tail-high
  out.push(
    bumpIfFlat({
      idx: 21,
      lowPrice: round4(doubleP),
      highPrice: TAIL_HIGH_MAX,
      isTailLow: false,
      isTailHigh: true,
    }),
  );

  return out;
}

/**
 * Return the bin that contains `price`, mirroring SQL's `find_bin_for_price`.
 * Negative prices and prices ≥ TAIL_HIGH_MAX return null.
 */
export function findBinForPrice(ladder: readonly Bin[], price: number): Bin | null {
  if (!Number.isFinite(price) || price < 0) return null;
  for (const b of ladder) {
    if (price >= b.lowPrice && price < b.highPrice) return b;
  }
  return null;
}

function round4(n: number): number {
  // Avoid IEEE-754 drift for common values. Matches Postgres round(numeric, 4)
  // semantics for positive numbers in our range.
  return Math.round(n * 10_000) / 10_000;
}

function bumpIfFlat(b: Bin): Bin {
  if (b.highPrice <= b.lowPrice) {
    return { ...b, highPrice: round4(b.lowPrice + 0.0001) };
  }
  return b;
}
