// Shared typed error-response helpers for haltmarket edge functions.

export const BET_ERROR_STATUS: Readonly<Record<string, number>> = {
  market_not_found: 404,
  market_closed: 409,
  price_outside_ladder: 400,
  invalid_price_precision: 400,
  insufficient_balance: 402,
  duplicate_idempotency_key: 409,
  rate_limited: 429,
  exceeds_per_market_limit: 409,
};

export function errResponse(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
