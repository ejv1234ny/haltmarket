import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@haltmarket/shared-types';
import { env, serviceRoleConfigured } from '../env';

// Service-role client for aggregations that RLS cannot satisfy with an
// anon cookie (leaderboards, global stats). Returns null when the service
// key isn't configured — callers fall back to fixture data in that path.
//
// IMPORTANT: never re-export this or its returned client from a module
// that a client component could import. `server-only` guards the bundle.
export function getServiceSupabase(): SupabaseClient<Database> | null {
  if (!serviceRoleConfigured) return null;
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}
