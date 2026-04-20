// Unit tests for bet validation, error mapping, and idempotency client code.
//
// Integration tests (requiring Postgres) live in integration.test.ts.

import { describe, expect, it } from 'vitest';
import {
  PlaceBetError,
  classifyPlaceBetSqlError,
  parseEdgeErrorResponse,
  previewBinForPrice,
  validatePlaceBetInput,
  type PlaceBetInput,
} from './bet.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

function baseInput(over: Partial<PlaceBetInput> = {}): PlaceBetInput {
  return {
    marketId: VALID_UUID,
    predictedPrice: 4.27,
    stakeMicro: 10_000_000n,
    idempotencyKey: OTHER_UUID,
    ...over,
  };
}

describe('validatePlaceBetInput', () => {
  it('accepts a well-formed input and mirrors bigint to string on the wire', () => {
    const r = validatePlaceBetInput(baseInput());
    if (!r.ok) throw new Error('expected ok');
    expect(r.payload.market_id).toBe(VALID_UUID);
    expect(r.payload.predicted_price).toBe(4.27);
    expect(r.payload.stake_micro).toBe('10000000');
    expect(r.payload.idempotency_key).toBe(OTHER_UUID);
  });

  it('rejects non-UUID marketId', () => {
    const r = validatePlaceBetInput(baseInput({ marketId: 'not-a-uuid' }));
    if (r.ok) throw new Error('expected error');
    expect(r.error.code).toBe('invalid_input');
  });

  it('rejects non-UUID idempotencyKey', () => {
    const r = validatePlaceBetInput(baseInput({ idempotencyKey: '123' }));
    if (r.ok) throw new Error('expected error');
    expect(r.error.code).toBe('invalid_input');
  });

  it('rejects non-positive predictedPrice', () => {
    for (const p of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = validatePlaceBetInput(baseInput({ predictedPrice: p }));
      if (r.ok) throw new Error(`expected error for ${p}`);
      expect(r.error.code).toBe('invalid_input');
    }
  });

  it('rejects predictedPrice with > 4 decimal places as invalid_price_precision', () => {
    const r = validatePlaceBetInput(baseInput({ predictedPrice: 4.27999 }));
    if (r.ok) throw new Error('expected error');
    expect(r.error.code).toBe('invalid_price_precision');
  });

  it('accepts predictedPrice with exactly 4 decimal places', () => {
    const r = validatePlaceBetInput(baseInput({ predictedPrice: 4.2799 }));
    expect(r.ok).toBe(true);
  });

  it('rejects scientific notation as invalid_price_precision', () => {
    // JS stringifies 1e-7 as "1e-7"; that would slip past a naive dot-based
    // decimal-places check. Explicit reject.
    const r = validatePlaceBetInput(baseInput({ predictedPrice: 1e-7 }));
    if (r.ok) throw new Error('expected error');
    expect(r.error.code).toBe('invalid_price_precision');
  });

  it('rejects non-positive stakeMicro', () => {
    for (const s of [0n, -1n]) {
      const r = validatePlaceBetInput(baseInput({ stakeMicro: s }));
      if (r.ok) throw new Error('expected error');
      expect(r.error.code).toBe('invalid_input');
    }
  });

  it('preserves full bigint precision on the wire (no number loss)', () => {
    // A stake larger than Number.MAX_SAFE_INTEGER proves the wire uses string.
    const huge = 9_999_999_999_999_999n; // > 2^53
    const r = validatePlaceBetInput(baseInput({ stakeMicro: huge }));
    if (!r.ok) throw new Error('expected ok');
    expect(r.payload.stake_micro).toBe('9999999999999999');
  });
});

describe('classifyPlaceBetSqlError', () => {
  it.each<[string, string]>([
    ['H0001', 'market_closed'],
    ['H0002', 'insufficient_balance'],
    ['H0003', 'duplicate_idempotency_key'],
    ['H0004', 'rate_limited'],
    ['H0005', 'exceeds_per_market_limit'],
    ['H0006', 'price_outside_ladder'],
    ['H0007', 'invalid_price_precision'],
    ['H0008', 'market_not_found'],
    ['H0099', 'invalid_input'],
  ])('maps SQLSTATE %s → %s', (sqlstate, expected) => {
    expect(classifyPlaceBetSqlError({ code: sqlstate })).toBe(expected);
  });

  it('maps raw 23505 → duplicate_idempotency_key (fallback)', () => {
    expect(classifyPlaceBetSqlError({ code: '23505' })).toBe(
      'duplicate_idempotency_key',
    );
  });

  it('defaults to internal_error on unknown code', () => {
    expect(classifyPlaceBetSqlError({ code: 'P0001', message: 'x' })).toBe(
      'internal_error',
    );
    expect(classifyPlaceBetSqlError({})).toBe('internal_error');
  });
});

describe('parseEdgeErrorResponse', () => {
  it('rehydrates a typed PlaceBetError from the edge JSON envelope', () => {
    const err = parseEdgeErrorResponse(
      { error: 'rate_limited', message: 'slow down' },
      429,
    );
    expect(err).toBeInstanceOf(PlaceBetError);
    expect(err.code).toBe('rate_limited');
    expect(err.message).toBe('slow down');
    expect(err.httpStatus).toBe(429);
  });

  it('falls back to internal_error for garbage responses', () => {
    expect(parseEdgeErrorResponse(null, 500).code).toBe('internal_error');
    expect(parseEdgeErrorResponse({ foo: 'bar' }, 500).code).toBe(
      'internal_error',
    );
    expect(parseEdgeErrorResponse({ error: 'made_up_code' }, 500).code).toBe(
      'internal_error',
    );
  });
});

describe('previewBinForPrice', () => {
  it('returns the bin a predicted_price will map to server-side', () => {
    // ADR-0002 worked example: last_price=4, reopen=4.27 → bin 11.
    const bin = previewBinForPrice(4, 4.27);
    expect(bin?.idx).toBe(11);
  });

  it('returns null when last_price is invalid', () => {
    expect(previewBinForPrice(0, 1)).toBeNull();
    expect(previewBinForPrice(-1, 1)).toBeNull();
    expect(previewBinForPrice(Number.NaN, 1)).toBeNull();
  });

  it('returns tail-high bin for prices above 2P', () => {
    const bin = previewBinForPrice(4, 100);
    expect(bin?.isTailHigh).toBe(true);
  });

  it('returns tail-low bin for prices below 0.5P', () => {
    const bin = previewBinForPrice(4, 1);
    expect(bin?.isTailLow).toBe(true);
  });

  it('returns null for negative predicted_price (matches SQL behavior)', () => {
    expect(previewBinForPrice(4, -1)).toBeNull();
  });
});
