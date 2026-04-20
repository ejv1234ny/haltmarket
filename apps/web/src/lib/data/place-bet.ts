'use client';

// Client-side call to the Phase 4 place-bet edge function. Split out of
// `./bets.ts` so it can be safely re-exported from `./index.ts` — the
// server-side bet queries in `./bets.ts` import `next/headers` via the
// server Supabase helper and would otherwise taint the client bundle.

import { getBrowserSupabase } from '../supabase/browser';
import { env, supabaseConfigured } from '../env';

export interface PlaceBetArgs {
  marketId: string;
  predictedPrice: number;
  stakeMicro: bigint;
  idempotencyKey: string;
}

export interface PlaceBetReceipt {
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

export class PlaceBetCallError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = 'PlaceBetCallError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * POST to the Phase 4 place-bet edge function. Requires a browser
 * Supabase session (the user's JWT is forwarded as the Authorization
 * header). Throws PlaceBetCallError on 4xx with `code` matching the
 * taxonomy from migration 0004_bets.sql.
 */
export async function callPlaceBet(args: PlaceBetArgs): Promise<PlaceBetReceipt> {
  if (!supabaseConfigured) {
    throw new PlaceBetCallError(
      'not_configured',
      'Supabase is not configured; place-bet requires the real backend.',
      503,
    );
  }
  const supabase = getBrowserSupabase();
  if (!supabase) {
    throw new PlaceBetCallError('not_configured', 'browser client unavailable', 503);
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData.session?.access_token;
  if (!jwt) {
    throw new PlaceBetCallError('unauthorized', 'sign in required', 401);
  }

  const res = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/place-bet`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        market_id: args.marketId,
        predicted_price: args.predictedPrice,
        stake_micro: args.stakeMicro.toString(),
        idempotency_key: args.idempotencyKey,
      }),
    },
  );

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : 'internal_error';
    const message = typeof body.message === 'string' ? body.message : code;
    throw new PlaceBetCallError(code, message, res.status);
  }
  return body as unknown as PlaceBetReceipt;
}
