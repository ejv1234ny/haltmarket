// Client-side validation and error-mapping for the place-bet edge function.
// Server-side invariants live in supabase/migrations/0004_place_bet.sql.
// ADR-0002: predicted_price is numeric(12,4) — max 4 decimal places.

export type BetErrorCode =
  | 'market_not_found'
  | 'market_closed'
  | 'price_outside_ladder'
  | 'invalid_price_precision'
  | 'insufficient_balance'
  | 'duplicate_idempotency_key'
  | 'rate_limited'
  | 'exceeds_per_market_limit'
  | 'invalid_market_id'
  | 'invalid_predicted_price'
  | 'invalid_stake_micro'
  | 'invalid_idempotency_key';

/** HTTP status for each error code (mirrors BET_ERROR_STATUS in _shared/errors.ts). */
export const BET_ERROR_STATUS: Readonly<Record<BetErrorCode, number>> = {
  market_not_found: 404,
  market_closed: 409,
  price_outside_ladder: 400,
  invalid_price_precision: 400,
  insufficient_balance: 402,
  duplicate_idempotency_key: 409,
  rate_limited: 429,
  exceeds_per_market_limit: 409,
  invalid_market_id: 400,
  invalid_predicted_price: 400,
  invalid_stake_micro: 400,
  invalid_idempotency_key: 400,
};

export class BetError extends Error {
  readonly code: BetErrorCode;
  constructor(code: BetErrorCode, message: string) {
    super(message);
    this.name = 'BetError';
    this.code = code;
  }
}

export interface BetRequest {
  market_id: string;
  predicted_price: number;
  stake_micro: bigint;
  idempotency_key: string;
}

export interface BetReceipt {
  bet_id: string;
  bin_id: string;
  new_bin_stake_micro: string;
  new_total_pool_micro: string;
  idempotent: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when value has ≤4 decimal places (ADR-0002 numeric(12,4) contract). */
export function hasAtMost4Decimals(value: number): boolean {
  const s = value.toString();
  const dot = s.indexOf('.');
  return dot === -1 || s.length - dot - 1 <= 4;
}

/**
 * Validates and normalises a raw bet request object.
 * Throws BetError for any invalid field; safe to call before the network call.
 */
export function validateBetRequest(raw: Record<string, unknown>): BetRequest {
  if (typeof raw.market_id !== 'string' || !UUID_RE.test(raw.market_id)) {
    throw new BetError('invalid_market_id', 'market_id must be a UUID');
  }

  if (
    typeof raw.predicted_price !== 'number' ||
    !Number.isFinite(raw.predicted_price) ||
    raw.predicted_price <= 0
  ) {
    throw new BetError(
      'invalid_predicted_price',
      'predicted_price must be a positive finite number',
    );
  }
  if (!hasAtMost4Decimals(raw.predicted_price)) {
    throw new BetError(
      'invalid_price_precision',
      'predicted_price must have at most 4 decimal places',
    );
  }

  let stakeMicro: bigint;
  try {
    stakeMicro = BigInt(raw.stake_micro as string | number);
    if (stakeMicro <= 0n) throw new Error('non-positive');
  } catch {
    throw new BetError(
      'invalid_stake_micro',
      'stake_micro must be a positive integer',
    );
  }

  if (
    typeof raw.idempotency_key !== 'string' ||
    !UUID_RE.test(raw.idempotency_key)
  ) {
    throw new BetError('invalid_idempotency_key', 'idempotency_key must be a UUID');
  }

  return {
    market_id: raw.market_id,
    predicted_price: raw.predicted_price,
    stake_micro: stakeMicro,
    idempotency_key: raw.idempotency_key,
  };
}

const RPC_ERROR_CODES = new Set<BetErrorCode>([
  'market_not_found',
  'market_closed',
  'price_outside_ladder',
  'invalid_price_precision',
  'insufficient_balance',
  'duplicate_idempotency_key',
  'rate_limited',
  'exceeds_per_market_limit',
]);

/**
 * Maps an RPC error message string from place_bet() to a typed BetErrorCode.
 * Unknown messages fall back to 'market_closed' as the safest 409 default.
 */
export function mapRpcError(message: string): BetErrorCode {
  return RPC_ERROR_CODES.has(message as BetErrorCode)
    ? (message as BetErrorCode)
    : 'market_closed';
}
