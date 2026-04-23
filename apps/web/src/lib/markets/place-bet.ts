'use client';

import { getBrowserSupabase } from '../supabase/browser';
import { env, supabaseConfigured } from '../env';

export type PlaceBetErrorCode =
  | 'market_closed'
  | 'insufficient_balance'
  | 'duplicate_idempotency_key'
  | 'rate_limited'
  | 'exceeds_per_market_limit'
  | 'aggregate_cap_exceeded'
  | 'price_outside_ladder'
  | 'invalid_price_precision'
  | 'market_not_found'
  | 'invalid_input'
  | 'unauthorized'
  | 'kyc_required'
  | 'region_blocked'
  | 'network_error'
  | 'internal_error';

export interface PlaceBetSuccess {
  ok: true;
  bet_id: string;
  market_id: string;
  bin_id: string;
  bin_idx: number;
  predicted_price: string;
  stake_micro: string;
  placed_at: string;
  new_bin_stake_micro: string;
  new_total_pool_micro: string;
  idempotent_replay: boolean;
}

export interface PlaceBetFailure {
  ok: false;
  code: PlaceBetErrorCode;
  message: string;
}

export type PlaceBetResult = PlaceBetSuccess | PlaceBetFailure;

export interface SubmitBetInput {
  marketId: string;
  predictedPrice: number;
  stakeMicro: bigint;
  idempotencyKey?: string;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for test envs without WebCrypto. Not cryptographic; only needs
  // to be unique per submission attempt.
  const rand = () => Math.random().toString(16).slice(2, 10);
  return `${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-${rand().slice(0, 4)}-${rand()}${rand().slice(0, 4)}`;
}

export async function submitBet(input: SubmitBetInput): Promise<PlaceBetResult> {
  if (!supabaseConfigured) {
    // Mock-mode: caller should handle its own optimistic state. Signal a
    // distinguishable success so the dev/demo flow still works end-to-end.
    return {
      ok: true,
      bet_id: `mock-bet-${Date.now()}`,
      market_id: input.marketId,
      bin_id: 'mock-bin',
      bin_idx: 0,
      predicted_price: input.predictedPrice.toString(),
      stake_micro: input.stakeMicro.toString(),
      placed_at: new Date().toISOString(),
      new_bin_stake_micro: input.stakeMicro.toString(),
      new_total_pool_micro: input.stakeMicro.toString(),
      idempotent_replay: false,
    };
  }

  const supabase = getBrowserSupabase();
  if (!supabase) {
    return { ok: false, code: 'internal_error', message: 'supabase client unavailable' };
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    return { ok: false, code: 'unauthorized', message: 'sign in to place a bet' };
  }

  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/place-bet`;
  const body = {
    market_id: input.marketId,
    predicted_price: input.predictedPrice,
    stake_micro: input.stakeMicro.toString(),
    idempotency_key: input.idempotencyKey ?? newIdempotencyKey(),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      message: (e as Error).message || 'request failed',
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return {
      ok: false,
      code: 'internal_error',
      message: `non-JSON response (${res.status})`,
    };
  }

  if (res.ok) {
    const p = payload as Omit<PlaceBetSuccess, 'ok'>;
    return { ok: true, ...p };
  }

  const err = payload as { error?: string; message?: string };
  return {
    ok: false,
    code: (err.error as PlaceBetErrorCode) ?? 'internal_error',
    message: err.message ?? `HTTP ${res.status}`,
  };
}

const USER_MESSAGES: Record<PlaceBetErrorCode, string> = {
  market_closed: 'This market has already closed.',
  insufficient_balance: 'Not enough USDC in your wallet.',
  duplicate_idempotency_key: 'Bet already submitted.',
  rate_limited: 'Too many bets — slow down for a moment.',
  exceeds_per_market_limit: 'You’ve hit the per-market stake cap ($1,000).',
  aggregate_cap_exceeded: 'Your total open exposure would exceed the $15,000 cap.',
  price_outside_ladder: 'That price is outside the bin ladder.',
  invalid_price_precision: 'Price has too many decimal places (max 4).',
  market_not_found: 'Market not found.',
  invalid_input: 'Invalid bet. Check your price and stake.',
  unauthorized: 'Sign in to place a bet.',
  kyc_required: 'Verify your identity before placing a bet.',
  region_blocked: 'Betting isn’t available in your region.',
  network_error: 'Network error. Try again.',
  internal_error: 'Something went wrong. Try again.',
};

export function messageFor(code: PlaceBetErrorCode): string {
  return USER_MESSAGES[code] ?? USER_MESSAGES.internal_error;
}
