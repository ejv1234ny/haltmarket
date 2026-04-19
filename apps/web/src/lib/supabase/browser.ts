'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@haltmarket/shared-types';
import { env, supabaseConfigured } from '../env';

let client: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getBrowserSupabase() {
  if (!supabaseConfigured) return null;
  if (!client) {
    client = createBrowserClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  }
  return client;
}
