import { describe, expect, it } from 'vitest';
import { buildLadder, impliedPayoutMultiple, resolveBin } from './bins';

describe('buildLadder', () => {
  it('produces 20 bins spanning 0.5× to 2.0× last price', () => {
    const bins = buildLadder('m1', 100);
    expect(bins).toHaveLength(20);
    expect(bins[0]!.low_price).toBeCloseTo(50, 0);
    expect(bins[19]!.high_price).toBeCloseTo(200, 0);
  });

  it('never emits a bin with low_price below the $0.01 floor', () => {
    const bins = buildLadder('m2', 0.02);
    for (const b of bins) expect(b.low_price).toBeGreaterThanOrEqual(0.01);
  });

  it('ladder is strictly monotonic', () => {
    const bins = buildLadder('m3', 118.42);
    for (let i = 1; i < bins.length; i += 1) {
      expect(bins[i]!.low_price).toBeGreaterThanOrEqual(bins[i - 1]!.low_price);
    }
  });
});

describe('resolveBin', () => {
  const bins = buildLadder('m', 100);

  it('maps a price inside the ladder to its bin', () => {
    const b = resolveBin(110, bins);
    expect(b).not.toBeNull();
    expect(b!.low_price).toBeLessThanOrEqual(110);
    expect(b!.high_price).toBeGreaterThan(110);
  });

  it('clamps below-range prices to the first bin', () => {
    expect(resolveBin(0.01, bins)?.idx).toBe(0);
  });

  it('clamps above-range prices to the last bin', () => {
    expect(resolveBin(10_000, bins)?.idx).toBe(19);
  });

  it('rejects nonsense input', () => {
    expect(resolveBin(Number.NaN, bins)).toBeNull();
    expect(resolveBin(-1, bins)).toBeNull();
    expect(resolveBin(100, [])).toBeNull();
  });
});

describe('impliedPayoutMultiple', () => {
  it('shrinks as the winning bin becomes a larger share of the pool', () => {
    // Two markets with the same total pool; the first has its stake concentrated
    // in the winning bin, the second has it spread across other bins.
    const concentrated = impliedPayoutMultiple(100_000_000, 100_000_000, 10_000_000, 500);
    const spread = impliedPayoutMultiple(10_000_000, 100_000_000, 10_000_000, 500);
    expect(spread).toBeGreaterThan(concentrated);
  });

  it('accounts for the fee (5%)', () => {
    const mult = impliedPayoutMultiple(0, 0, 1_000_000, 500);
    expect(mult).toBeCloseTo(0.95, 2);
  });
});
