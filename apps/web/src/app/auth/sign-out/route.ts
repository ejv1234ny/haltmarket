import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = getServerSupabase();
  if (supabase) await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', env.NEXT_PUBLIC_SITE_URL), { status: 303 });
}
