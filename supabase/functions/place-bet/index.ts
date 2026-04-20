// place-bet — Phase 4 edge function.
//
// POST { market_id, predicted_price, stake_micro, idempotency_key }
//   → validates inputs → resolves user from JWT
//   → calls place_bet() RPC (SERIALIZABLE transaction)
//   → broadcasts bin_delta on markets:{market_id} realtime channel
//   → returns bet receipt (201 new, 200 idempotent repeat)
//
// Deploy:  supabase functions deploy place-bet
//
// Env required (auto-provided in edge runtime):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  BET_ERROR_STATUS,
  errResponse,
  jsonResponse,
} from '../_shared/errors.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasAtMost4Decimals(value: number): boolean {
  const s = value.toString();
  const dot = s.indexOf('.');
  return dot === -1 || s.length - dot - 1 <= 4;
}

interface PlaceBetBody {
  market_id: unknown;
  predicted_price: unknown;
  stake_micro: unknown;
  idempotency_key: unknown;
}

interface PlaceBetResult {
  idempotent: boolean;
  bet_id: string;
  bin_id: string;
  new_bin_stake_micro: string;
  new_total_pool_micro: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('missing server config', { status: 500 });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return errResponse('unauthorized', 401);
  }
  const userToken = authHeader.slice(7);

  let body: PlaceBetBody;
  try {
    body = (await req.json()) as PlaceBetBody;
  } catch {
    return errResponse('invalid_json', 400);
  }

  const { market_id, predicted_price, stake_micro, idempotency_key } = body;

  if (typeof market_id !== 'string' || !UUID_RE.test(market_id)) {
    return errResponse('invalid_market_id', 400);
  }

  if (
    typeof predicted_price !== 'number' ||
    !Number.isFinite(predicted_price) ||
    predicted_price <= 0
  ) {
    return errResponse('invalid_predicted_price', 400);
  }
  if (!hasAtMost4Decimals(predicted_price)) {
    return errResponse('invalid_price_precision', 400);
  }

  let stakeMicro: bigint;
  try {
    stakeMicro = BigInt(stake_micro as string | number);
    if (stakeMicro <= 0n) throw new Error('non-positive');
  } catch {
    return errResponse('invalid_stake_micro', 400);
  }

  if (
    typeof idempotency_key !== 'string' ||
    !UUID_RE.test(idempotency_key)
  ) {
    return errResponse('invalid_idempotency_key', 400);
  }

  const authClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await authClient.auth.getUser(userToken);
  if (authErr || !user) {
    return errResponse('unauthorized', 401);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const txnId = crypto.randomUUID();

  const { data, error } = await supabase.rpc('place_bet', {
    p_user_id: user.id,
    p_market_id: market_id,
    p_predicted_price: predicted_price,
    p_stake_micro: stakeMicro.toString(),
    p_idempotency_key: idempotency_key,
    p_txn_id: txnId,
  });

  if (error) {
    const code = error.message ?? 'internal_error';
    const status = BET_ERROR_STATUS[code] ?? 500;
    return errResponse(code, status);
  }

  const result = data as PlaceBetResult;

  // Realtime broadcast: non-fatal; bet is already committed.
  fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify({
      messages: [
        {
          topic: `markets:${market_id}`,
          event: 'bin_delta',
          payload: {
            type: 'bin_delta',
            bin_id: result.bin_id,
            new_stake_micro: result.new_bin_stake_micro,
            new_total_pool_micro: result.new_total_pool_micro,
          },
        },
      ],
    }),
  }).catch((e: unknown) => console.error('realtime broadcast failed:', e));

  return jsonResponse(
    {
      bet_id: result.bet_id,
      bin_id: result.bin_id,
      new_bin_stake_micro: result.new_bin_stake_micro,
      new_total_pool_micro: result.new_total_pool_micro,
      idempotent: result.idempotent,
    },
    result.idempotent ? 200 : 201,
  );
});
