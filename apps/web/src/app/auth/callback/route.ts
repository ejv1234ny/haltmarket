import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';
  const supabase = getServerSupabase();
  if (code && supabase) {
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, env.NEXT_PUBLIC_SITE_URL));
}
