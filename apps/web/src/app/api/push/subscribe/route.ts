// POST   /api/push/subscribe  — register a browser subscription
// DELETE /api/push/subscribe  — unregister by endpoint

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string;
}

type FromFn = {
  upsert: (
    row: Record<string, unknown>,
    opts: { onConflict: string },
  ) => Promise<{ error: { message: string } | null }>;
  delete: () => {
    eq: (k: string, v: string) => Promise<{ error: { message: string } | null }>;
  };
};

export async function POST(req: Request): Promise<Response> {
  const supabase = getServerSupabase();
  if (!supabase) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const p = body as Partial<SubscribePayload>;
  if (typeof p?.endpoint !== 'string' || !p.keys?.p256dh || !p.keys?.auth) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }

  const { error } = await (supabase.from('push_subscriptions') as unknown as FromFn).upsert(
    {
      user_id: userData.user.id,
      endpoint: p.endpoint,
      p256dh: p.keys.p256dh,
      auth: p.keys.auth,
      user_agent: p.user_agent ?? null,
    },
    { onConflict: 'endpoint' },
  );
  if (error) {
    console.error('push subscribe failed', error);
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request): Promise<Response> {
  const supabase = getServerSupabase();
  if (!supabase) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const endpoint = (body as { endpoint?: string })?.endpoint;
  if (typeof endpoint !== 'string') {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }

  const { error } = await (supabase.from('push_subscriptions') as unknown as FromFn)
    .delete()
    .eq('endpoint', endpoint);
  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
