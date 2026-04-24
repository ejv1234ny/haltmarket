// Supabase admin helpers for the real-data Playwright spec. We call the
// auth admin API (service-role) to create a user with a password + generate
// a verify link so the browser can sign in without hitting a mail server.
//
// Only used when PLAYWRIGHT_USE_REAL_DB=1. Requires:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// The generated magic-link verify URL points at Supabase's /auth/v1/verify
// endpoint. Navigating Playwright to that URL triggers the redirect to
// /auth/callback which @supabase/ssr intercepts and sets the session
// cookies on the Next.js host.

export interface AdminEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
  siteUrl: string;
}

export function loadAdminEnv(): AdminEnv | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000';
  if (!supabaseUrl || !serviceRoleKey) return null;
  return { supabaseUrl, serviceRoleKey, siteUrl };
}

export async function createAdminUser(
  env: AdminEnv,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${env.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) {
    throw new Error(`admin create user ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error('admin create user returned no id');
  return body.id;
}

/**
 * Swap an already-created user id for a verify URL. Playwright navigates
 * the browser to this URL to get a real signed-in cookie session.
 */
export async function generateMagicLink(
  env: AdminEnv,
  email: string,
): Promise<string> {
  const res = await fetch(`${env.supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
    },
    body: JSON.stringify({
      type: 'magiclink',
      email,
      options: { redirect_to: `${env.siteUrl}/auth/callback` },
    }),
  });
  if (!res.ok) {
    throw new Error(`generate_link ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    action_link?: string;
    properties?: { action_link?: string };
  };
  const link = body.action_link ?? body.properties?.action_link;
  if (!link) throw new Error('generate_link returned no action_link');
  return link;
}
