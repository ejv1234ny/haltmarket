// notify-halt — fans out a Web Push notification to every active
// push_subscriptions row when a new market opens.
//
// Triggered by a DB webhook on `public.markets` INSERT (Supabase dashboard
// → Database → Webhooks). Alternative: call from a pg_cron schedule that
// scans new market rows.
//
// Payload (DB webhook style):
//   {
//     type: 'INSERT',
//     table: 'markets',
//     record: { id, halt_id, last_price, ... },
//   }
//
// VAPID signing happens via @negrel/webpush for Deno. Auth: a shared bearer
// `NOTIFY_HALT_KEY` protects the endpoint from public calls.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import * as webpush from 'https://esm.sh/@negrel/webpush@0.3.0';

interface MarketRecord {
  id: string;
  halt_id: string;
  last_price: string | number;
}

interface HookPayload {
  type: string;
  table: string;
  record?: MarketRecord;
}

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Deno?.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (globalThis as any).Deno?.env;
  const supabaseUrl = env?.get('SUPABASE_URL');
  const serviceKey = env?.get('SUPABASE_SERVICE_ROLE_KEY');
  const vapidPublic = env?.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = env?.get('VAPID_PRIVATE_KEY');
  const vapidSubject = env?.get('VAPID_SUBJECT') ?? 'mailto:ops@haltmarket.com';
  const sharedKey = env?.get('NOTIFY_HALT_KEY') ?? '';

  if (!supabaseUrl || !serviceKey) return json(500, { error: 'misconfigured' });
  if (!vapidPublic || !vapidPrivate) {
    return json(503, { error: 'vapid_keys_missing' });
  }

  if (sharedKey) {
    const caller = req.headers.get('x-notify-key') ?? '';
    if (caller !== sharedKey) return json(401, { error: 'unauthorized' });
  }

  let payload: HookPayload;
  try {
    payload = (await req.json()) as HookPayload;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (payload.type !== 'INSERT' || payload.table !== 'markets' || !payload.record) {
    // Not a market insert — ack and skip so Supabase doesn't retry.
    return json(200, { skipped: true });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Look up the symbol via halts → only need the record.halt_id.
  const { data: halt } = await db
    .from('halts')
    .select('symbol')
    .eq('id', payload.record.halt_id)
    .maybeSingle();
  const symbol = (halt as { symbol?: string } | null)?.symbol ?? 'UNK';

  const { data: subsRaw, error: subsErr } = await db
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth');
  if (subsErr) return json(500, { error: 'db_error', message: subsErr.message });
  const subs = (subsRaw ?? []) as Subscription[];

  // Configure web-push once.
  const applicationServer = await webpush.ApplicationServer.new({
    contactInformation: vapidSubject,
    vapidKeys: await webpush.importVapidKeys(
      {
        publicKey: vapidPublic,
        privateKey: vapidPrivate,
      },
      { extractable: false },
    ),
  });

  const body = JSON.stringify({
    title: `🔴 ${symbol} halted`,
    body: `Halt price $${payload.record.last_price}. Predict the reopen.`,
    market_id: payload.record.id,
    symbol,
  });

  const results = await Promise.allSettled(
    subs.map(async (s) => {
      const subscriber = applicationServer.subscribe({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      });
      await subscriber.pushTextMessage(body, {});
    }),
  );

  // Clean up dead subscriptions (410 Gone / 404) so we don't keep trying.
  const dead: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const msg = String(r.reason?.message ?? r.reason ?? '');
      if (msg.includes('410') || msg.includes('404')) {
        dead.push(subs[i]!.endpoint);
      }
    }
  });
  if (dead.length > 0) {
    await db.from('push_subscriptions').delete().in('endpoint', dead);
  }

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  const pushResult = { delivered: ok, failed, pruned: dead.length };

  // Email fanout — opt-in. Skipped when RESEND_API_KEY is absent (dev).
  const resendKey = env?.get('RESEND_API_KEY') ?? '';
  const mailFrom = env?.get('RESEND_FROM_EMAIL') ?? 'no-reply@haltmarket.com';
  let emailResult: { sent: number; failed: number } | { skipped: true } = { skipped: true };
  if (resendKey) {
    const { data: targetsRaw, error: targetsErr } =
      await db.rpc('get_email_notify_targets');
    if (targetsErr) {
      console.error('get_email_notify_targets failed', targetsErr);
    } else {
      const targets = ((targetsRaw ?? []) as { user_id: string; email: string }[])
        .filter((t) => t.email && t.email.includes('@'));
      let sent = 0;
      let emailFailed = 0;
      for (const t of targets) {
        try {
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${resendKey}`,
            },
            body: JSON.stringify({
              from: mailFrom,
              to: [t.email],
              subject: `${symbol} halted — predict the reopen`,
              html: `<p>${symbol} was halted at $${payload.record.last_price}.</p>
                     <p><a href="https://haltmarket.com/market/${payload.record.id}">Make your prediction →</a></p>
                     <p style="font-size:12px;color:#888">Unsubscribe: open Profile → turn off email notifications.</p>`,
            }),
          });
          if (res.ok) sent++;
          else {
            emailFailed++;
            console.error(`resend ${res.status}: ${await res.text().catch(() => '')}`);
          }
        } catch (e) {
          emailFailed++;
          console.error('resend fetch failed', (e as Error).message);
        }
      }
      emailResult = { sent, failed: emailFailed };
    }
  }

  return json(200, { push: pushResult, email: emailResult });
});
