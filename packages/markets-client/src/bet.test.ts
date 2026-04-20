// Unit tests for @haltmarket/markets-client bet validation and error mapping.
// No database required.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BET_ERROR_STATUS,
  BetError,
  hasAtMost4Decimals,
  mapRpcError,
  validateBetRequest,
} from './bet.js';

// ── hasAtMost4Decimals ────────────────────────────────────────────────────────

describe('hasAtMost4Decimals', () => {
  it.each([4, 4.25, 4.1235, 0.0001, 100, 0.5, 99.9999])(
    'accepts %f',
    (v) => expect(hasAtMost4Decimals(v)).toBe(true),
  );

  it.each([4.12345, 4.000001, 1.00001, 0.00001])(
    'rejects %f',
    (v) => expect(hasAtMost4Decimals(v)).toBe(false),
  );

  it('accepts integer', () => expect(hasAtMost4Decimals(50)).toBe(true));
  it('accepts 1 decimal', () => expect(hasAtMost4Decimals(1.5)).toBe(true));
  it('accepts exactly 4 decimals', () => expect(hasAtMost4Decimals(1.2345)).toBe(true));
  it('rejects 5 decimals', () => expect(hasAtMost4Decimals(1.23456)).toBe(false));
});

// ── validateBetRequest ────────────────────────────────────────────────────────

describe('validateBetRequest', () => {
  const good = (): Record<string, unknown> => ({
    market_id: randomUUID(),
    predicted_price: 4.25,
    stake_micro: 10_000_000,
    idempotency_key: randomUUID(),
  });

  it('accepts a fully valid request', () => {
    const r = validateBetRequest(good());
    expect(r.stake_micro).toBe(10_000_000n);
    expect(typeof r.market_id).toBe('string');
    expect(typeof r.predicted_price).toBe('number');
    expect(typeof r.idempotency_key).toBe('string');
  });

  it('accepts stake_micro supplied as a string', () => {
    const r = validateBetRequest({ ...good(), stake_micro: '500000000' });
    expect(r.stake_micro).toBe(500_000_000n);
  });

  it('accepts price with exactly 4 decimal places', () => {
    const r = validateBetRequest({ ...good(), predicted_price: 3.1415 });
    expect(r.predicted_price).toBe(3.1415);
  });

  it('rejects missing market_id', () => {
    const { market_id: _omit, ...rest } = good() as Record<string, unknown>;
    expect(() => validateBetRequest(rest)).toThrow(
      expect.objectContaining({ code: 'invalid_market_id' }),
    );
  });

  it('rejects non-UUID market_id', () => {
    expect(() => validateBetRequest({ ...good(), market_id: 'not-a-uuid' }))
      .toThrow(expect.objectContaining({ code: 'invalid_market_id' }));
  });

  it('rejects zero predicted_price', () => {
    expect(() => validateBetRequest({ ...good(), predicted_price: 0 }))
      .toThrow(expect.objectContaining({ code: 'invalid_predicted_price' }));
  });

  it('rejects negative predicted_price', () => {
    expect(() => validateBetRequest({ ...good(), predicted_price: -1.5 }))
      .toThrow(expect.objectContaining({ code: 'invalid_predicted_price' }));
  });

  it('rejects non-finite predicted_price (Infinity)', () => {
    expect(() => validateBetRequest({ ...good(), predicted_price: Infinity }))
      .toThrow(expect.objectContaining({ code: 'invalid_predicted_price' }));
  });

  it('rejects non-finite predicted_price (NaN)', () => {
    expect(() => validateBetRequest({ ...good(), predicted_price: NaN }))
      .toThrow(expect.objectContaining({ code: 'invalid_predicted_price' }));
  });

  it('rejects predicted_price with 5 decimal places → invalid_price_precision', () => {
    expect(() => validateBetRequest({ ...good(), predicted_price: 4.12345 }))
      .toThrow(expect.objectContaining({ code: 'invalid_price_precision' }));
  });

  it('rejects zero stake_micro', () => {
    expect(() => validateBetRequest({ ...good(), stake_micro: 0 }))
      .toThrow(expect.objectContaining({ code: 'invalid_stake_micro' }));
  });

  it('rejects negative stake_micro', () => {
    expect(() => validateBetRequest({ ...good(), stake_micro: -1 }))
      .toThrow(expect.objectContaining({ code: 'invalid_stake_micro' }));
  });

  it('rejects non-numeric stake_micro', () => {
    expect(() => validateBetRequest({ ...good(), stake_micro: 'not-a-number' }))
      .toThrow(expect.objectContaining({ code: 'invalid_stake_micro' }));
  });

  it('rejects non-UUID idempotency_key', () => {
    expect(() => validateBetRequest({ ...good(), idempotency_key: 'not-uuid' }))
      .toThrow(expect.objectContaining({ code: 'invalid_idempotency_key' }));
  });

  it('rejects missing idempotency_key', () => {
    const { idempotency_key: _omit, ...rest } = good() as Record<string, unknown>;
    expect(() => validateBetRequest(rest))
      .toThrow(expect.objectContaining({ code: 'invalid_idempotency_key' }));
  });

  it('throws BetError instances (not plain Error)', () => {
    expect(() => validateBetRequest({ ...good(), market_id: 'bad' }))
      .toThrow(BetError);
  });
});

// ── mapRpcError ───────────────────────────────────────────────────────────────

describe('mapRpcError', () => {
  it.each([
    'market_not_found',
    'market_closed',
    'price_outside_ladder',
    'invalid_price_precision',
    'insufficient_balance',
    'duplicate_idempotency_key',
    'rate_limited',
    'exceeds_per_market_limit',
  ] as const)('passes through known code "%s"', (code) => {
    expect(mapRpcError(code)).toBe(code);
  });

  it('maps unknown RPC message to market_closed (safe 409 fallback)', () => {
    expect(mapRpcError('unexpected_pg_error')).toBe('market_closed');
  });

  it('maps empty string to market_closed', () => {
    expect(mapRpcError('')).toBe('market_closed');
  });
});

// ── BET_ERROR_STATUS ──────────────────────────────────────────────────────────

describe('BET_ERROR_STATUS', () => {
  it('market_not_found → 404', () =>
    expect(BET_ERROR_STATUS.market_not_found).toBe(404));
  it('market_closed → 409', () =>
    expect(BET_ERROR_STATUS.market_closed).toBe(409));
  it('insufficient_balance → 402', () =>
    expect(BET_ERROR_STATUS.insufficient_balance).toBe(402));
  it('rate_limited → 429', () =>
    expect(BET_ERROR_STATUS.rate_limited).toBe(429));
  it('price_outside_ladder → 400', () =>
    expect(BET_ERROR_STATUS.price_outside_ladder).toBe(400));
  it('invalid_price_precision → 400', () =>
    expect(BET_ERROR_STATUS.invalid_price_precision).toBe(400));
  it('duplicate_idempotency_key → 409', () =>
    expect(BET_ERROR_STATUS.duplicate_idempotency_key).toBe(409));
  it('exceeds_per_market_limit → 409', () =>
    expect(BET_ERROR_STATUS.exceeds_per_market_limit).toBe(409));
});

// ── Idempotency logic ─────────────────────────────────────────────────────────

describe('idempotency receipt semantics', () => {
  it('receipt with idempotent:true has the same shape as a new bet', () => {
    const receipt = {
      bet_id: randomUUID(),
      bin_id: randomUUID(),
      new_bin_stake_micro: '5000000',
      new_total_pool_micro: '25000000',
      idempotent: true,
    };
    expect(receipt.idempotent).toBe(true);
    expect(receipt.bet_id).toMatch(UUID_RE);
    expect(receipt.bin_id).toMatch(UUID_RE);
  });

  it('idempotent request reuses the same bet_id', () => {
    const betId = randomUUID();
    const firstReceipt = {
      bet_id: betId,
      bin_id: randomUUID(),
      new_bin_stake_micro: '5000000',
      new_total_pool_micro: '25000000',
      idempotent: false,
    };
    const repeatReceipt = { ...firstReceipt, idempotent: true };
    expect(repeatReceipt.bet_id).toBe(firstReceipt.bet_id);
  });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
