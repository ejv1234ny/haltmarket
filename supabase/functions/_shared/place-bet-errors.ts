// Shared error contract for the place-bet edge function.
//
// The Phase 4 DB function `public.place_bet(...)` raises typed SQLSTATE codes
// (class 'H0' — PG's user-reserved range; see supabase/migrations/0004_bets.sql
// header). This module is the one place that maps those codes to the 4xx
// taxonomy the client sees. The `@haltmarket/markets-client` package imports
// the same map so server + client agree on the string contract.

export type PlaceBetErrorCode =
  | 'market_closed'
  | 'insufficient_balance'
  | 'duplicate_idempotency_key'
  | 'rate_limited'
  | 'exceeds_per_market_limit'
  | 'price_outside_ladder'
  | 'invalid_price_precision'
  | 'market_not_found'
  | 'invalid_input'
  | 'unauthorized'
  | 'internal_error';

export interface PlaceBetErrorResponse {
  error: PlaceBetErrorCode;
  message: string;
}

// SQLSTATE → code mapping. Must match the `raise exception using errcode`
// values in migration 0004_bets.sql step-by-step.
const SQLSTATE_MAP: Record<string, PlaceBetErrorCode> = {
  H0001: 'market_closed',
  H0002: 'insufficient_balance',
  H0003: 'duplicate_idempotency_key',
  H0004: 'rate_limited',
  H0005: 'exceeds_per_market_limit',
  H0006: 'price_outside_ladder',
  H0007: 'invalid_price_precision',
  H0008: 'market_not_found',
  H0099: 'invalid_input',
};

// HTTP status for each error code. Matches the 4xx-only taxonomy from the
// Phase 4 brief; internal_error is the sole 5xx.
const HTTP_STATUS: Record<PlaceBetErrorCode, number> = {
  market_closed: 410,
  insufficient_balance: 402,
  duplicate_idempotency_key: 409,
  rate_limited: 429,
  exceeds_per_market_limit: 409,
  price_outside_ladder: 422,
  invalid_price_precision: 422,
  market_not_found: 404,
  invalid_input: 400,
  unauthorized: 401,
  internal_error: 500,
};

export interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/** Map a Postgres error (from supabase-js RPC) to a typed place-bet code. */
export function classifySqlError(err: PostgrestLikeError): PlaceBetErrorCode {
  const code = err.code ?? '';
  if (code in SQLSTATE_MAP) return SQLSTATE_MAP[code] as PlaceBetErrorCode;
  // 23505 is the fallback for raw unique-constraint violations that somehow
  // escape the typed H0003 remap — treat as duplicate idempotency.
  if (code === '23505') return 'duplicate_idempotency_key';
  return 'internal_error';
}

export function statusFor(code: PlaceBetErrorCode): number {
  return HTTP_STATUS[code];
}

export function errorResponse(
  code: PlaceBetErrorCode,
  message?: string,
): Response {
  const body: PlaceBetErrorResponse = {
    error: code,
    message: message ?? code,
  };
  return new Response(JSON.stringify(body), {
    status: statusFor(code),
    headers: { 'content-type': 'application/json' },
  });
}
