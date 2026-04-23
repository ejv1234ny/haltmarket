// reconcile-crypto — scheduled hourly (pg_cron or external scheduler).
//
// Compares ledger-side crypto custody to on-chain USDC balance of the
// hot + cold Safe wallets on Base. If drift exceeds the threshold
// ($1 by default), posts a Discord alert and flips `deposits_frozen`.
//
// Contract:
//   GET /functions/v1/reconcile-crypto
//   Auth: header `x-reconcile-key: <RECONCILE_KEY>` (to stop open-web calls).
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   HOT_WALLET_ADDRESS  — 0x...
//   COLD_WALLET_ADDRESS — 0x...
//   USDC_BASE_ADDRESS   — 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
//   BASE_RPC_URL        — https://mainnet.base.org (or Alchemy endpoint)
//   DISCORD_WEBHOOK_URL — optional; skip alerts if missing
//   RECONCILE_KEY       — shared secret for the scheduler call

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const DRIFT_THRESHOLD_MICROS = 1_000_000n;  // $1
const USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Minimal eth_call wrapper. balanceOf(address) selector = 0x70a08231.
async function usdcBalance(
  rpcUrl: string,
  usdcAddress: string,
  holder: string,
): Promise<bigint | null> {
  const data = '0x70a08231' + holder.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: usdcAddress, data }, 'latest'],
      }),
    });
    if (!res.ok) {
      console.error(`rpc status ${res.status}`);
      return null;
    }
    const json = await res.json() as { result?: string; error?: unknown };
    if (!json.result) {
      console.error('rpc error', json.error);
      return null;
    }
    return BigInt(json.result);
  } catch (e) {
    console.error('rpc fetch failed', (e as Error).message);
    return null;
  }
}

async function postDiscord(url: string, content: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: 'Reconciliation alert',
            description: content,
            color: 0xe74c3c,
          },
        ],
      }),
    });
  } catch (e) {
    console.error('discord post failed', (e as Error).message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Deno?.serve(async (req: Request) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (globalThis as any).Deno?.env;
  const url = env?.get('SUPABASE_URL');
  const serviceKey = env?.get('SUPABASE_SERVICE_ROLE_KEY');
  const hot = env?.get('HOT_WALLET_ADDRESS') ?? '';
  const cold = env?.get('COLD_WALLET_ADDRESS') ?? '';
  const usdc = env?.get('USDC_BASE_ADDRESS') ?? USDC_DEFAULT;
  const rpc = env?.get('BASE_RPC_URL') ?? 'https://mainnet.base.org';
  const webhook = env?.get('DISCORD_WEBHOOK_URL') ?? '';
  const key = env?.get('RECONCILE_KEY') ?? '';

  if (key) {
    const caller = req.headers.get('x-reconcile-key') ?? '';
    if (caller !== key) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: 'misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: ledgerRows, error: ledgerErr } =
    await db.rpc('reconcile_crypto_ledger');
  if (ledgerErr) {
    return new Response(
      JSON.stringify({ error: 'rpc_failed', message: ledgerErr.message }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
  const ledger = Array.isArray(ledgerRows) && ledgerRows[0]
    ? (ledgerRows[0] as Record<string, unknown>)
    : null;
  if (!ledger) {
    return new Response(
      JSON.stringify({ error: 'no_rows' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  const [hotBal, coldBal] = await Promise.all([
    hot ? usdcBalance(rpc, usdc, hot) : Promise.resolve(null),
    cold ? usdcBalance(rpc, usdc, cold) : Promise.resolve(null),
  ]);
  const onChain = (hotBal ?? 0n) + (coldBal ?? 0n);

  const ledgerCustody = BigInt(String(ledger['ledger_custody_micro'] ?? '0'));
  const inFlight = BigInt(String(ledger['in_flight_withdraw_micro'] ?? '0'));
  const drift = onChain - (ledgerCustody < 0n ? -ledgerCustody : ledgerCustody) - inFlight;

  const body = {
    on_chain_micros: onChain.toString(),
    hot_micros: hotBal?.toString() ?? null,
    cold_micros: coldBal?.toString() ?? null,
    ledger_custody_micros: ledgerCustody.toString(),
    in_flight_micros: inFlight.toString(),
    drift_micros: drift.toString(),
    threshold_micros: DRIFT_THRESHOLD_MICROS.toString(),
    breach: drift > DRIFT_THRESHOLD_MICROS || drift < -DRIFT_THRESHOLD_MICROS,
  };

  if (body.breach) {
    // Freeze deposits by flipping the flag. The flag is read at every
    // credit_crypto_deposit call; frozen state is surfaced to ops within
    // the Discord post.
    const { error: flagErr } = await db
      .from('system_flags')
      .update({
        value: true,
        note: `auto-frozen by reconcile-crypto; drift=${drift.toString()} micros`,
        updated_at: new Date().toISOString(),
      })
      .eq('flag', 'deposits_frozen');
    if (flagErr) console.error('failed to freeze deposits', flagErr);

    if (webhook) {
      const sign = drift > 0n ? '+' : '';
      await postDiscord(
        webhook,
        `**Crypto drift detected.** on-chain=${onChain} custody=${ledgerCustody} in_flight=${inFlight} drift=${sign}${drift} micros. **Deposits auto-frozen.** Follow docs/runbook-drift.md.`,
      );
    }
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
