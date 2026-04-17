import { getServerSupabase } from './supabase/server';
import { MOCK_USER } from './mocks/fixtures';

export interface SessionUser {
  id: string;
  email: string;
}

// Returns the active Supabase user if credentials are configured; otherwise
// falls back to the mock user so the app is browsable end-to-end in dev
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
  return { id: MOCK_USER.id, email: MOCK_USER.email };
}
