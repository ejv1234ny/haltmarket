// check-ledger-invariants — hourly-scheduled edge function.
//
// Verifies the two ADR-0001 invariants against production:
//   (1) global SUM(ledger_entries.amount_micro) = 0
//   (2) sampled wallets.balance_micro == SUM(ledger_entries.amount_micro)
//       for each (user_id, account, currency) in a random 1000-row sample
//
// On any discrepancy, posts a Discord alert via DISCORD_WEBHOOK_URL and returns
// 500 so Supabase's scheduled-function retry logic keeps paging.
//
// Deploy:  supabase functions deploy check-ledger-invariants
// Schedule (cron, hourly):
//   supabase functions schedule create check-ledger-invariants --cron "0 * * * *"
//
// Env required:
//   SUPABASE_URL               (auto-provided in edge runtime)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-provided in edge runtime)
//   DISCORD_WEBHOOK_URL        (set via `supabase secrets set`)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

interface DriftRow {
  user_id: string;
  account: string;
  currency: string;
  cache_balance_micro: string;
  entries_sum_micro: string;
  drift_micro: string;
}

const SAMPLE_SIZE = 1000;

async function postDiscord(webhook: string, content: string): Promise<void> {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Discord returns 403 on requests without a User-Agent.
      'User-Agent': 'haltmarket-invariant-check/1.0 (+https://haltmarket.com)',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error(`discord webhook ${res.status}: ${await res.text()}`);
  }
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const discordWebhook = Deno.env.get('DISCORD_WEBHOOK_URL');

  if (!supabaseUrl || !serviceKey) {
    return new Response('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', {
      status: 500,
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const failures: string[] = [];

  // (1) global sum
  const { data: sumData, error: sumErr } = await supabase.rpc(
    'ledger_global_sum',
  );
  if (sumErr) {
    failures.push(`ledger_global_sum RPC failed: ${sumErr.message}`);
  } else if (sumData !== 0 && sumData !== '0') {
    failures.push(
      `GLOBAL SUM ≠ 0 — ledger_global_sum() returned ${sumData}. ` +
        `Freeze place-bet and follow docs/runbook-drift.md.`,
    );
  }

  // (2) wallet-cache drift, sampled
  const { data: driftRows, error: driftErr } = await supabase.rpc(
    'ledger_wallet_drift',
    { p_sample_limit: SAMPLE_SIZE },
  );
  if (driftErr) {
    failures.push(`ledger_wallet_drift RPC failed: ${driftErr.message}`);
  } else {
    const rows = (driftRows ?? []) as DriftRow[];
    if (rows.length > 0) {
      const preview = rows
        .slice(0, 5)
        .map(
          (r) =>
            `  user=${r.user_id} account=${r.account} ` +
            `cache=${r.cache_balance_micro} entries=${r.entries_sum_micro} ` +
            `drift=${r.drift_micro}`,
        )
        .join('\n');
      failures.push(
        `WALLET CACHE DRIFT — ${rows.length} / ${SAMPLE_SIZE} sampled rows ` +
          `disagree with ledger_entries. First few:\n${preview}`,
      );
    }
  }

  const timestamp = new Date().toISOString();

  if (failures.length === 0) {
    console.log(`[${timestamp}] invariants ok`);
    return new Response(
      JSON.stringify({ ok: true, checked_at: timestamp, sampled: SAMPLE_SIZE }),
      { headers: { 'content-type': 'application/json' } },
    );
  }

  const alert =
    `:rotating_light: **haltmarket ledger invariant failure** @ ${timestamp}\n` +
    failures.map((f) => `• ${f}`).join('\n');
  console.error(alert);

  if (discordWebhook) {
    await postDiscord(discordWebhook, alert);
  } else {
    console.error('DISCORD_WEBHOOK_URL not set — alert logged only');
  }

  return new Response(JSON.stringify({ ok: false, failures }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
});
