import { describe, expect, it } from 'vitest';
import { buildLadder, impliedBonusMicro, impliedMainPayoutMultiple, resolveBin } from './bins';

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

describe('impliedMainPayoutMultiple (ADR-0002 hybrid)', () => {
  it('matches the 88% main pool when the bin owns the whole pool', () => {
    const mult = impliedMainPayoutMultiple(0, 0, 1_000_000, 500, 700);
    expect(mult).toBeCloseTo(0.88, 2);
  });

  it('shrinks as the winning bin becomes a larger share of the pool', () => {
    const concentrated = impliedMainPayoutMultiple(100_000_000, 100_000_000, 10_000_000, 500, 700);
    const spread = impliedMainPayoutMultiple(10_000_000, 100_000_000, 10_000_000, 500, 700);
    expect(spread).toBeGreaterThan(concentrated);
  });
});

describe('impliedBonusMicro', () => {
  it('returns 7% of the new gross pool', () => {
    const bonus = impliedBonusMicro(93_000_000, 7_000_000, 700);
    expect(bonus).toBe(7_000_000);
  });

  it('scales linearly with the gross pool', () => {
    const small = impliedBonusMicro(100_000, 0, 700);
    const big = impliedBonusMicro(10_000_000, 0, 700);
    expect(big).toBe(small * 100);
  });
});
