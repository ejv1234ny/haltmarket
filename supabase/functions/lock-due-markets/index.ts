// lock-due-markets — scheduled edge function (every 15 seconds).
//
// Calls public.lock_due_markets(), which transitions any `open` market whose
// `closes_at <= now()` to `locked`. SKIP LOCKED inside the RPC lets concurrent
// resolve flows proceed without head-of-line blocking.
//
// Phase 3 deliverable per AGENTS.md §Phase 3. The 15-second cadence comes from
// the same section — it's slower than the 90s close window so late-closed
// markets stay open at most ~15s past their `closes_at`. Phase 4 place-bet
// enforces `now() < closes_at` independently, so the window between "should
// lock" and "has locked" is not exploitable.
//
// Deploy:  supabase functions deploy lock-due-markets
// Schedule (cron syntax — every 15s via supabase scheduler):
//   supabase functions schedule create lock-due-markets --cron "*/15 * * * * *"
//
// Env required:
//   SUPABASE_URL               (auto-provided in edge runtime)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-provided in edge runtime)
//   DISCORD_WEBHOOK_URL        (optional — paged only on RPC failure)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

async function postDiscord(webhook: string, content: string): Promise<void> {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'haltmarket-lock-due-markets/1.0 (+https://haltmarket.com)',
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

  const startedAt = new Date().toISOString();

  const { data, error } = await supabase.rpc('lock_due_markets');

  if (error) {
    const alert =
      `:warning: **lock_due_markets RPC failed** @ ${startedAt} — ${error.message}. ` +
      `Markets that should have locked may still be accepting bets until the next tick.`;
    console.error(alert);
    if (discordWebhook) await postDiscord(discordWebhook, alert);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  const locked = Number(data ?? 0);
  if (locked > 0) {
    console.log(`[${startedAt}] locked ${locked} markets`);
  }

  return new Response(
    JSON.stringify({ ok: true, locked, ran_at: startedAt }),
    { headers: { 'content-type': 'application/json' } },
  );
});
