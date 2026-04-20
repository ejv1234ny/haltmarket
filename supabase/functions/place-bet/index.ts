// place-bet — Phase 4 hot path.
//
// Contract:
//   POST  { market_id, predicted_price, stake_micro, idempotency_key }
//   Auth: Supabase JWT (Authorization: Bearer ...). User is derived server-side.
//
// Flow:
//   1. Validate request shape (reject 400s before any DB round-trip).
//   2. Resolve user from the JWT via supabase.auth.getUser.
//   3. Call public.place_bet(...) — atomic inside the PostgREST-wrapped txn.
//      The RPC enforces market status, closes_at, bin lookup, rate limit,
//      aggregate cap, overdraft, idempotency, and ledger consistency.
//   4. On success, broadcast bin_delta to markets:{market_id} so Phase 7
//      frontend subscribers update live without a polling round-trip.
//
// The RPC returns a single row with the bet receipt + post-write bin + pool
// totals, so the broadcast does not require a second query. The broadcast
// uses Supabase's realtime REST endpoint — no WebSocket handshake on the
// hot path, keeping p95 under 500ms.
//
// Deploy:  supabase functions deploy place-bet
// Env required (auto in edge runtime):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  classifySqlError,
  errorResponse,
  type PostgrestLikeError,
} from '../_shared/place-bet-errors.ts';
import { parsePlaceBetRequest } from '../_shared/place-bet-validation.ts';

interface PlaceBetRow {
  bet_id: string;
  bin_id: string;
  bin_idx: number;
  predicted_price: string; // numeric comes back as string
  stake_micro: string;
  placed_at: string;
  new_bin_stake_micro: string;
  new_total_pool_micro: string;
  idempotent_replay: boolean;
}

async function broadcastBinDelta(
  supabaseUrl: string,
  serviceKey: string,
  marketId: string,
  row: PlaceBetRow,
): Promise<void> {
  // Best-effort: a broadcast failure must not fail the bet. The DB write
  // is already committed; subscribers that miss the broadcast will see the
  // updated state on their next `markets` select (Phase 7 falls back).
  try {
    const res = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `markets:${marketId}`,
            event: 'bin_delta',
            payload: {
              type: 'bin_delta',
              bin_id: row.bin_id,
              new_stake_micro: row.new_bin_stake_micro,
              new_total_pool_micro: row.new_total_pool_micro,
            },
            private: false,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(
        `realtime broadcast ${res.status}: ${await res.text().catch(() => '')}`,
      );
    }
  } catch (e) {
    console.error(`realtime broadcast threw: ${(e as Error).message}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return errorResponse('invalid_input', 'method must be POST');
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('missing SUPABASE env vars');
    return errorResponse('internal_error', 'edge runtime misconfigured');
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (!jwt) {
    return errorResponse('unauthorized', 'missing bearer token');
  }

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return errorResponse('invalid_input', 'invalid JSON body');
  }

  const parsed = parsePlaceBetRequest(bodyJson);
  if (!parsed.ok) {
    return errorResponse(parsed.err.kind, parsed.err.message);
  }
  const input = parsed.value;

  // Auth: use anon-key client with the user's JWT to resolve the user id.
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
  if (userErr || !userData.user) {
    return errorResponse('unauthorized', userErr?.message ?? 'invalid JWT');
  }
  const userId = userData.user.id;

  // DB call: service-role client so we can invoke SECURITY DEFINER RPCs.
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.rpc('place_bet', {
    p_user_id: userId,
    p_market_id: input.marketId,
    p_predicted_price: input.predictedPrice,
    p_stake_micro: input.stakeMicro.toString(),
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    const code = classifySqlError(error as PostgrestLikeError);
    if (code === 'internal_error') {
      console.error(`place_bet RPC failed: ${error.code} ${error.message}`);
    }
    return errorResponse(code, error.message);
  }

  const rows = (data ?? []) as PlaceBetRow[];
  const row = rows[0];
  if (!row) {
    console.error('place_bet returned 0 rows');
    return errorResponse('internal_error', 'no bet row returned');
  }

  if (!row.idempotent_replay) {
    await broadcastBinDelta(supabaseUrl, serviceKey, input.marketId, row);
  }

  return new Response(
    JSON.stringify({
      bet_id: row.bet_id,
      market_id: input.marketId,
      bin_id: row.bin_id,
      bin_idx: row.bin_idx,
      predicted_price: row.predicted_price,
      stake_micro: row.stake_micro,
      placed_at: row.placed_at,
      new_bin_stake_micro: row.new_bin_stake_micro,
      new_total_pool_micro: row.new_total_pool_micro,
      idempotent_replay: row.idempotent_replay,
    }),
    {
      status: row.idempotent_replay ? 200 : 201,
      headers: { 'content-type': 'application/json' },
    },
  );
});
