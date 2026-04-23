import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerSupabase } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { UserRow } from './user-row';

export const dynamic = 'force-dynamic';

interface UserRowT {
  user_id: string;
  email: string | null;
  handle: string | null;
  kyc_status: string | null;
  is_admin: boolean;
  created_at: string;
}

type RpcFn = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

type ProfileLookupFn = {
  select: (cols: string) => {
    eq: (k: string, v: string) => {
      maybeSingle: () => Promise<{ data: { is_admin: boolean } | null }>;
    };
  };
};

async function loadUsers(query: string | undefined): Promise<
  | { kind: 'unconfigured' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; users: UserRowT[]; currentUserId: string }
> {
  if (!supabaseConfigured) return { kind: 'unconfigured' };
  const supabase = getServerSupabase();
  if (!supabase) return { kind: 'unconfigured' };
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { kind: 'forbidden' };

  const profileRes = await (supabase.from('user_profiles') as unknown as ProfileLookupFn)
    .select('is_admin')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (!profileRes.data || profileRes.data.is_admin !== true) {
    return { kind: 'forbidden' };
  }

  const rpc = await (supabase.rpc as unknown as RpcFn)('admin_list_users', {
    p_limit: 200,
    p_query: query ?? null,
  });
  const rows = Array.isArray(rpc.data)
    ? (rpc.data as Record<string, unknown>[]).map((r) => ({
        user_id: String(r.user_id),
        email: (r.email as string | null) ?? null,
        handle: (r.handle as string | null) ?? null,
        kyc_status: (r.kyc_status as string | null) ?? null,
        is_admin: Boolean(r.is_admin),
        created_at: String(r.created_at),
      }))
    : [];

  return { kind: 'ok', users: rows, currentUserId: userData.user.id };
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  const q = searchParams?.q?.trim();
  const data = await loadUsers(q && q.length > 0 ? q : undefined);
  if (data.kind === 'unconfigured') notFound();
  if (data.kind === 'forbidden') redirect('/');

  const { users, currentUserId } = data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h1 className="font-mono text-3xl font-bold tracking-tight">Users</h1>
          <Link href="/admin" className="text-xs text-neutral-400 hover:text-neutral-200">
            ← back to admin
          </Link>
        </div>
        <p className="text-sm text-neutral-400">
          Manage handles, KYC status, and admin role. Last 200 sign-ups.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
        </CardHeader>
        <CardContent>
          <form action="/admin/users" method="GET" className="flex gap-2">
            <input
              name="q"
              defaultValue={q ?? ''}
              placeholder="email or handle substring"
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100"
            />
            <button
              type="submit"
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-emerald-400"
            >
              Filter
            </button>
            {q && (
              <Link
                href="/admin/users"
                className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
              >
                Clear
              </Link>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{users.length} users</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {users.length === 0 ? (
            <p className="p-4 text-sm text-neutral-400">No users match.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">Handle · email</th>
                  <th className="px-3 py-2 text-left">KYC</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Joined</th>
                  <th className="px-3 py-2 text-left">Admin action</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.user_id} row={u} currentUserId={currentUserId} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
