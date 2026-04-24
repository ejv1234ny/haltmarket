import { redirect } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerSupabase } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { EmailNotifyToggle } from './email-toggle';
import { HandleForm } from './handle-form';

export const dynamic = 'force-dynamic';

interface ProfileRow {
  handle: string | null;
  kyc_status: string | null;
  geo_country: string | null;
  is_admin: boolean | null;
  notify_email_on_halt: boolean | null;
}

type FromFn = {
  select: (cols: string) => {
    eq: (k: string, v: string) => {
      maybeSingle: () => Promise<{ data: ProfileRow | null; error: unknown }>;
    };
  };
};

async function loadProfile(): Promise<
  | { kind: 'unconfigured' }
  | { kind: 'unauthenticated' }
  | { kind: 'ok'; email: string; profile: ProfileRow | null }
> {
  if (!supabaseConfigured) return { kind: 'unconfigured' };
  const supabase = getServerSupabase();
  if (!supabase) return { kind: 'unconfigured' };
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return { kind: 'unauthenticated' };

  const { data } = await (supabase.from('user_profiles') as unknown as FromFn)
    .select('handle, kyc_status, geo_country, is_admin, notify_email_on_halt')
    .eq('user_id', user.id)
    .maybeSingle();

  return { kind: 'ok', email: user.email ?? '', profile: data };
}

function KycBadge({ status }: { status: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    none: { label: 'not started', cls: 'bg-neutral-900 text-neutral-400' },
    pending: { label: 'pending', cls: 'bg-amber-950/40 text-amber-300' },
    approved: { label: 'approved', cls: 'bg-emerald-950/40 text-emerald-300' },
    rejected: { label: 'rejected', cls: 'bg-red-950/40 text-red-300' },
  };
  const s = map[status ?? 'none'] ?? map.none!;
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

export default async function ProfilePage() {
  const data = await loadProfile();

  if (data.kind === 'unconfigured') {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-sm text-amber-300">
          Profile requires Supabase credentials. Running in demo mode.
        </p>
      </main>
    );
  }
  if (data.kind === 'unauthenticated') redirect('/sign-in');

  const { email, profile } = data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-sm text-neutral-400">
          Pick a handle for the leaderboard, and review compliance status.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-neutral-400">
            Account
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">Email</span>
            <span className="font-mono text-neutral-200">{email}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">KYC status</span>
            <KycBadge status={profile?.kyc_status ?? null} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">Region</span>
            <span className="font-mono text-neutral-200">
              {profile?.geo_country ?? '—'}
            </span>
          </div>
          {profile?.is_admin && (
            <div className="flex items-center justify-between">
              <span className="text-neutral-400">Role</span>
              <span className="font-mono text-sky-300">admin</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Handle</CardTitle>
        </CardHeader>
        <CardContent>
          <HandleForm initialHandle={profile?.handle ?? ''} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <EmailNotifyToggle initial={profile?.notify_email_on_halt ?? false} />
        </CardContent>
      </Card>
    </main>
  );
}
