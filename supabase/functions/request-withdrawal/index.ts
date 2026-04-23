// request-withdrawal — Phase 8 withdrawal entry point.
//
// Contract:
//   POST { amount_micro, destination_address, chain_id? }
//   Auth: Supabase JWT. User id derived server-side.
//
// Flow:
//   1. Validate shape (amount_micro > 0, address matches 0x[40 hex]).
//   2. Resolve user from JWT.
//   3. Call public.request_withdrawal(...) — atomic: inserts withdrawals
//      row + reserves balance via post_transfer. SQLSTATE H0016/H0017
//      and 22023 map to 4xx codes. post_transfer overdraft check_violation
//      → 402 insufficient_balance.
//
// Deploy: supabase functions deploy request-withdrawal

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type WithdrawalErrorCode =
  | 'withdrawals_frozen'
  | 'withdrawal_below_min'
  | 'invalid_address'
  | 'insufficient_balance'
  | 'invalid_input'
  | 'unauthorized'
  | 'internal_error';

const HTTP_STATUS: Record<WithdrawalErrorCode, number> = {
  withdrawals_frozen: 503,
  withdrawal_below_min: 400,
  invalid_address: 400,
  insufficient_balance: 402,
  invalid_input: 400,
  unauthorized: 401,
  internal_error: 500,
};

function errorResponse(code: WithdrawalErrorCode, message?: string): Response {
  return new Response(
    JSON.stringify({ error: code, message: message ?? code }),
    { status: HTTP_STATUS[code], headers: { 'content-type': 'application/json' } },
  );
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BASE_CHAIN_ID = 8453;

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

function classify(err: PostgrestLikeError): WithdrawalErrorCode {
  const code = err.code ?? '';
  const msg = (err.message ?? '').toLowerCase();
  if (code === 'H0016') return 'withdrawals_frozen';
  if (code === 'H0017') return 'withdrawal_below_min';
  if (code === '22023') {
    // Both invalid address and other arg validation land here. Use the
    // message to disambiguate.
    if (msg.includes('destination') || msg.includes('address')) return 'invalid_address';
    return 'invalid_input';
  }
  // post_transfer overdraft — check_violation surfacing "balance < 0" msg.
  if (code === '23514' && msg.includes('negative')) return 'insufficient_balance';
  if (msg.includes('negative') && msg.includes('user_wallet')) return 'insufficient_balance';
  return 'internal_error';
}

interface ParsedBody {
  amountMicro: bigint;
  destination: string;
  chainId: number;
}

function parseBody(raw: unknown):
  | { ok: true; value: ParsedBody }
  | { ok: false; code: WithdrawalErrorCode; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'invalid_input', message: 'body must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;

  const stakeRaw = r['amount_micro'];
  let amountMicro: bigint;
  try {
    if (typeof stakeRaw === 'string') {
      if (!/^\d+$/.test(stakeRaw)) throw new Error('digits');
      amountMicro = BigInt(stakeRaw);
    } else if (typeof stakeRaw === 'number' && Number.isSafeInteger(stakeRaw)) {
      amountMicro = BigInt(stakeRaw);
    } else {
      throw new Error('type');
    }
  } catch {
    return { ok: false, code: 'invalid_input', message: 'amount_micro must be a positive integer' };
  }
  if (amountMicro <= 0n) {
    return { ok: false, code: 'invalid_input', message: 'amount_micro must be positive' };
  }

  const destination = typeof r['destination_address'] === 'string'
    ? (r['destination_address'] as string)
    : '';
  if (!ADDRESS_RE.test(destination)) {
    return { ok: false, code: 'invalid_address', message: 'destination_address must be 0x + 40 hex' };
  }

  const chainRaw = r['chain_id'];
  const chainId = typeof chainRaw === 'number' && Number.isSafeInteger(chainRaw)
    ? chainRaw
    : BASE_CHAIN_ID;

  return { ok: true, value: { amountMicro, destination, chainId } };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Deno?.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return errorResponse('invalid_input', 'method must be POST');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (globalThis as any).Deno?.env;
  const supabaseUrl = env?.get('SUPABASE_URL');
  const serviceKey = env?.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = env?.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('missing SUPABASE env vars');
    return errorResponse('internal_error', 'edge runtime misconfigured');
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (!jwt) return errorResponse('unauthorized', 'missing bearer token');

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return errorResponse('invalid_input', 'invalid JSON body');
  }

  const parsed = parseBody(bodyJson);
  if (!parsed.ok) return errorResponse(parsed.code, parsed.message);
  const { amountMicro, destination, chainId } = parsed.value;

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
  if (userErr || !userData.user) {
    return errorResponse('unauthorized', userErr?.message ?? 'invalid JWT');
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.rpc('request_withdrawal', {
    p_user_id: userData.user.id,
    p_amount_micro: amountMicro.toString(),
    p_destination_address: destination,
    p_chain_id: chainId,
  });

  if (error) {
    const code = classify(error as PostgrestLikeError);
    if (code === 'internal_error') {
      console.error(`request_withdrawal RPC failed: ${error.code} ${error.message}`);
    }
    return errorResponse(code, error.message);
  }

  return new Response(
    JSON.stringify({ withdrawal_id: data }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
});
