// Bet-placement client surface for @haltmarket/markets-client.
//
// The TS client is the caller-side contract for the `place-bet` edge
// function (supabase/functions/place-bet/) and the `place_bet(...)` RPC
// (supabase/migrations/0004_bets.sql). The validation + error-mapping
// code here mirrors the edge-side shared helpers in
// supabase/functions/_shared/place-bet-*.ts — both sides agree on the
// same error code strings so server-returned JSON parses cleanly here.

import { computeBinLadder, findBinForPrice, type Bin } from './ladder.js';

// -----------------------------------------------------------------------------
// Error taxonomy — must match supabase/functions/_shared/place-bet-errors.ts.
// -----------------------------------------------------------------------------

export type PlaceBetErrorCode =
  | 'market_closed'
  | 'insufficient_balance'
  | 'duplicate_idempotency_key'
  | 'rate_limited'
  | 'exceeds_per_market_limit'
  | 'price_outside_ladder'
  | 'invalid_price_precision'
  | 'market_not_found'
  | 'kyc_required'
  | 'region_blocked'
  | 'aggregate_cap_exceeded'
  | 'invalid_input'
  | 'unauthorized'
  | 'internal_error';

export class PlaceBetError extends Error {
  readonly code: PlaceBetErrorCode;
  readonly httpStatus: number | null;
  constructor(code: PlaceBetErrorCode, message?: string, httpStatus?: number) {
    super(message ?? code);
    this.name = 'PlaceBetError';
    this.code = code;
    this.httpStatus = httpStatus ?? null;
  }
}

// SQLSTATE → code mapping mirrors migration 0004_bets.sql.
const SQLSTATE_MAP: Record<string, PlaceBetErrorCode> = {
  H0001: 'market_closed',
  H0002: 'insufficient_balance',
  H0003: 'duplicate_idempotency_key',
  H0004: 'rate_limited',
  H0005: 'exceeds_per_market_limit',
  H0006: 'price_outside_ladder',
  H0007: 'invalid_price_precision',
  H0008: 'market_not_found',
  H0009: 'kyc_required',
  H0010: 'region_blocked',
  H0011: 'aggregate_cap_exceeded',
  H0099: 'invalid_input',
};

/** Map a Postgres error (from supabase-js RPC) to a typed PlaceBetErrorCode. */
export function classifyPlaceBetSqlError(err: {
  code?: string;
  message?: string;
}): PlaceBetErrorCode {
  const code = err.code ?? '';
  if (code in SQLSTATE_MAP) return SQLSTATE_MAP[code] as PlaceBetErrorCode;
  if (code === '23505') return 'duplicate_idempotency_key';
  return 'internal_error';
}

/** Map an edge-function JSON error envelope to a PlaceBetError. */
export function parseEdgeErrorResponse(body: unknown, httpStatus: number): PlaceBetError {
  if (typeof body === 'object' && body !== null) {
    const r = body as Record<string, unknown>;
    const code = r['error'];
    if (typeof code === 'string' && isPlaceBetErrorCode(code)) {
      const message = typeof r['message'] === 'string' ? (r['message'] as string) : code;
      return new PlaceBetError(code, message, httpStatus);
    }
  }
  return new PlaceBetError('internal_error', 'unrecognized error response', httpStatus);
}

function isPlaceBetErrorCode(s: string): s is PlaceBetErrorCode {
  return (
    s === 'market_closed' ||
    s === 'insufficient_balance' ||
    s === 'duplicate_idempotency_key' ||
    s === 'rate_limited' ||
    s === 'exceeds_per_market_limit' ||
    s === 'price_outside_ladder' ||
    s === 'invalid_price_precision' ||
    s === 'market_not_found' ||
    s === 'kyc_required' ||
    s === 'region_blocked' ||
    s === 'aggregate_cap_exceeded' ||
    s === 'invalid_input' ||
    s === 'unauthorized' ||
    s === 'internal_error'
  );
}

// -----------------------------------------------------------------------------
// Client-side request validation. Runs before any RPC round-trip so the
// bet UI can show inline errors without hitting the network.
// -----------------------------------------------------------------------------

export interface PlaceBetInput {
  marketId: string;
  predictedPrice: number;
  stakeMicro: bigint;
  idempotencyKey: string;
}

export interface PlaceBetWirePayload {
  market_id: string;
  predicted_price: number;
  stake_micro: string;
  idempotency_key: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a PlaceBetInput and return either the wire payload or a typed
 * PlaceBetError — callers can surface the error inline without catching.
 */
export function validatePlaceBetInput(
  input: PlaceBetInput,
): { ok: true; payload: PlaceBetWirePayload } | { ok: false; error: PlaceBetError } {
  if (!UUID_RE.test(input.marketId)) {
    return {
      ok: false,
      error: new PlaceBetError('invalid_input', 'marketId must be a UUID'),
    };
  }
  if (!UUID_RE.test(input.idempotencyKey)) {
    return {
      ok: false,
      error: new PlaceBetError('invalid_input', 'idempotencyKey must be a UUID'),
    };
  }
  if (!Number.isFinite(input.predictedPrice) || input.predictedPrice <= 0) {
    return {
      ok: false,
      error: new PlaceBetError(
        'invalid_input',
        'predictedPrice must be a positive finite number',
      ),
    };
  }
  const priceStr = input.predictedPrice.toString();
  // JS stringifies very small numbers in scientific notation (e.g. 1e-7),
  // which bypasses the literal decimal-place check. Reject the exponent
  // form outright — these prices are always outside a reasonable halt
  // ladder anyway, and the server would raise price_outside_ladder.
  if (priceStr.includes('e') || priceStr.includes('E')) {
    return {
      ok: false,
      error: new PlaceBetError(
        'invalid_price_precision',
        'predictedPrice must not use scientific notation',
      ),
    };
  }
  const dot = priceStr.indexOf('.');
  if (dot >= 0 && priceStr.length - dot - 1 > 4) {
    return {
      ok: false,
      error: new PlaceBetError(
        'invalid_price_precision',
        'predictedPrice must have at most 4 decimal places',
      ),
    };
  }
  if (input.stakeMicro <= 0n) {
    return {
      ok: false,
      error: new PlaceBetError('invalid_input', 'stakeMicro must be positive'),
    };
  }

  return {
    ok: true,
    payload: {
      market_id: input.marketId,
      predicted_price: input.predictedPrice,
      stake_micro: input.stakeMicro.toString(),
      idempotency_key: input.idempotencyKey,
    },
  };
}

/**
 * Preview the server-derived bin for a predicted price, given the market's
 * last_price. Used by the Phase 7 input — "Your guess $X · bin $A–$B" —
 * without round-tripping to the DB on every keystroke. Returns null when
 * the price is outside the ladder (server will raise price_outside_ladder
 * on actual submit; clients should surface the same UX hint).
 */
export function previewBinForPrice(
  lastPrice: number,
  predictedPrice: number,
): Bin | null {
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  const ladder = computeBinLadder(lastPrice);
  return findBinForPrice(ladder, predictedPrice);
}
