'use server';

import { revalidatePath } from 'next/cache';
import { getServerSupabase } from '@/lib/supabase/server';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export type ProfileActionResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'invalid_handle' | 'handle_taken' | 'internal_error'; message: string };

export async function setHandleAction(handle: string): Promise<ProfileActionResult> {
  const normalized = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(normalized)) {
    return {
      ok: false,
      error: 'invalid_handle',
      message: 'handle must be 3–20 chars, lowercase letters/digits/underscore',
    };
  }

  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: 'internal_error', message: 'supabase not configured' };

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return { ok: false, error: 'unauthorized', message: 'sign in first' };

  // Upsert into user_profiles. RLS policies from migration 0006 gate both
  // insert and update to auth.uid() = user_id, so the row can only land
  // under the current session's user id.
  const { error } = await (
    supabase.from('user_profiles') as unknown as {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => Promise<{ error: { message: string; code?: string } | null }>;
    }
  ).upsert(
    { user_id: user.id, handle: normalized, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );

  if (error) {
    // Postgres 23505 on the unique (handle) index means someone else has it.
    if (error.code === '23505') {
      return { ok: false, error: 'handle_taken', message: 'that handle is taken' };
    }
    console.error('setHandleAction error', error);
    return { ok: false, error: 'internal_error', message: error.message };
  }

  revalidatePath('/profile');
  revalidatePath('/leaderboard');
  return { ok: true };
}

export async function setEmailNotifyAction(
  enabled: boolean,
): Promise<ProfileActionResult> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: 'internal_error', message: 'supabase not configured' };
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return { ok: false, error: 'unauthorized', message: 'sign in first' };

  const { error } = await (
    supabase.from('user_profiles') as unknown as {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => Promise<{ error: { message: string; code?: string } | null }>;
    }
  ).upsert(
    { user_id: user.id, notify_email_on_halt: enabled, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) {
    console.error('setEmailNotifyAction error', error);
    return { ok: false, error: 'internal_error', message: error.message };
  }
  revalidatePath('/profile');
  return { ok: true };
}
