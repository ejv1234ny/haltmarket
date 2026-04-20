import { getServerSupabase } from './supabase/server';
import { DEMO_USER } from './data';

export interface SessionUser {
  id: string;
  email: string;
}

// Returns the active Supabase user if credentials are configured; otherwise
// falls back to the demo user so the app is browsable end-to-end in dev
// before the project ref is wired. Swap happens automatically once
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are set.
export async function getSessionUser(): Promise<SessionUser> {
  const supabase = getServerSupabase();
  if (supabase) {
    const { data } = await supabase.auth.getUser();
    if (data.user && data.user.email) {
      return { id: data.user.id, email: data.user.email };
    }
  }
  return { id: DEMO_USER.id, email: DEMO_USER.email };
}
