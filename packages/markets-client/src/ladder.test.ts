// Unit tests for the bin-ladder algorithm (TS mirror of SQL compute_bin_ladder).
//
// Integration tests in `integration.test.ts` assert the SQL function agrees
// with this TS implementation across the full price range.

import { describe, expect, it } from 'vitest';
import { computeBinLadder, findBinForPrice, TAIL_HIGH_MAX, type Bin } from './ladder.js';

function at(ladder: readonly Bin[], idx: number): Bin {
  const b = ladder[idx];
  if (!b) throw new Error(`ladder has no bin at idx ${idx}`);
  return b;
}

describe('computeBinLadder', () => {
  it('produces exactly 22 bins', () => {
    for (const p of [0.1, 1, 4, 25, 100, 1000, 10_000]) {
      expect(computeBinLadder(p)).toHaveLength(22);
    }
  });

  it('idx 0 is tail-low and covers [0, 0.5P)', () => {
    const ladder = computeBinLadder(4);
    expect(at(ladder, 0)).toMatchObject({
      idx: 0,
      lowPrice: 0,
      highPrice: 2,
      isTailLow: true,
      isTailHigh: false,
    });
  });

  it('idx 21 is tail-high and covers [2P, TAIL_HIGH_MAX)', () => {
    const ladder = computeBinLadder(4);
    expect(at(ladder, 21)).toMatchObject({
      idx: 21,
      lowPrice: 8,
      highPrice: TAIL_HIGH_MAX,
      isTailLow: false,
      isTailHigh: true,
    });
  });

  it('main bins span exactly 0.5P → 2P end-to-end', () => {
    const ladder = computeBinLadder(4);
    expect(at(ladder, 1).lowPrice).toBe(2);
    expect(at(ladder, 20).highPrice).toBe(8);
  });

  it('consecutive main bins are contiguous — no gaps, no overlap', () => {
    const ladder = computeBinLadder(25);
    for (let i = 1; i < 21; i++) {
      expect(at(ladder, i).highPrice).toBe(at(ladder, i + 1).lowPrice);
    }
    // tails meet the main bins
    expect(at(ladder, 0).highPrice).toBe(at(ladder, 1).lowPrice);
    expect(at(ladder, 20).highPrice).toBe(at(ladder, 21).lowPrice);
  });

  it('main bins are log-spaced: ratio is constant (4^(1/20))', () => {
    const ladder = computeBinLadder(100);
    const expectedRatio = Math.pow(4, 1 / 20);
    for (let i = 2; i <= 20; i++) {
      const bin = at(ladder, i);
      const ratio = bin.highPrice / bin.lowPrice;
      expect(ratio).toBeCloseTo(expectedRatio, 3);
    }
  });

  it('ladder[i].low < ladder[i].high for every bin', () => {
    for (const p of [0.1, 0.5, 1, 4, 25, 500, 10_000]) {
      for (const b of computeBinLadder(p)) {
        expect(b.lowPrice).toBeLessThan(b.highPrice);
      }
    }
  });

  it('penny stock $0.10 — idx 10 straddles last_price within rounding', () => {
    const ladder = computeBinLadder(0.1);
    expect(at(ladder, 10).highPrice).toBe(0.1);
    expect(at(ladder, 11).lowPrice).toBe(0.1);
  });

  it('large-cap $10,000 — bins span $5K → $20K', () => {
    const ladder = computeBinLadder(10_000);
    expect(at(ladder, 1).lowPrice).toBe(5_000);
    expect(at(ladder, 20).highPrice).toBe(20_000);
  });

  it('price below ladder maps to tail-low', () => {
    const ladder = computeBinLadder(4);
    expect(findBinForPrice(ladder, 0.01)?.idx).toBe(0);
    expect(findBinForPrice(ladder, 1.99)?.idx).toBe(0);
  });

  it('price above 2P maps to tail-high', () => {
    const ladder = computeBinLadder(4);
    expect(findBinForPrice(ladder, 8)?.idx).toBe(21);
    expect(findBinForPrice(ladder, 100)?.idx).toBe(21);
  });

  it('reopen example from ADR-0002 resolves to the winning bin', () => {
    // last_price=$4.00, reopen=$4.27 → bin 11 [4.00, 4.2871)
    const ladder = computeBinLadder(4);
    const bin = findBinForPrice(ladder, 4.27);
    expect(bin?.idx).toBe(11);
    expect(bin?.lowPrice).toBe(4);
    expect(bin?.highPrice).toBeCloseTo(4.2871, 4);
  });

  it('negative and non-finite prices throw', () => {
    expect(() => computeBinLadder(0)).toThrow();
    expect(() => computeBinLadder(-1)).toThrow();
    expect(() => computeBinLadder(Number.NaN)).toThrow();
    expect(() => computeBinLadder(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('findBinForPrice rejects negative or NaN prices', () => {
    const ladder = computeBinLadder(10);
    expect(findBinForPrice(ladder, -1)).toBeNull();
    expect(findBinForPrice(ladder, Number.NaN)).toBeNull();
  });
});
