// POST /api/wallet-address
//
// Called by the Privy WalletSyncer component on first embedded-wallet
// provision (and idempotent on reload). Forwards to the
// `register_wallet_address` SECURITY INVOKER RPC so the DB-side RLS decides
// whether the user can bind an address — we don't have to re-auth anything
// on this route.

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

const BASE_CHAIN_ID = 8453;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  const r = body as Record<string, unknown>;
  const address = typeof r.address === 'string' ? r.address : '';
  const source = typeof r.source === 'string' ? r.source : 'privy';
  const chainIdRaw = r.chain_id;
  const chainId = typeof chainIdRaw === 'number' ? chainIdRaw : BASE_CHAIN_ID;

  if (!ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: 'invalid_address' }, { status: 400 });
  }
  if (source !== 'privy' && source !== 'self') {
    return NextResponse.json({ error: 'invalid_source' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // The Database type in @haltmarket/shared-types is a placeholder (no RPCs
  // declared), so strongly-typed rpc() rejects our args. Cast to bypass —
  // validation happens server-side in the SECURITY INVOKER RPC.
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>)(
    'register_wallet_address',
    { p_chain_id: chainId, p_address: address, p_source: source },
  );

  if (error) {
    console.error('register_wallet_address failed', error);
    return NextResponse.json(
      { error: 'rpc_failed', message: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: data ?? null, chain_id: chainId, address });
}
