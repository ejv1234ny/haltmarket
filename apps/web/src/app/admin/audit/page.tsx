import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerSupabase } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';

export const dynamic = 'force-dynamic';

interface LogRow {
  id: string;
  actor_email: string | null;
  actor_handle: string | null;
  action: string;
  target_user_id: string | null;
  target: string | null;
  payload: Record<string, unknown> | null;
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

async function loadLog(page: number): Promise<
  | { kind: 'unconfigured' }
  | { kind: 'forbidden' }
  | { kind: 'ok'; rows: LogRow[]; page: number }
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

  const pageSize = 50;
  const offset = Math.max(page, 0) * pageSize;
  const rpc = await (supabase.rpc as unknown as RpcFn)('admin_get_action_log', {
    p_limit: pageSize,
    p_offset: offset,
  });

  const rows: LogRow[] = Array.isArray(rpc.data)
    ? (rpc.data as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        actor_email: (r.actor_email as string | null) ?? null,
        actor_handle: (r.actor_handle as string | null) ?? null,
        action: String(r.action),
        target_user_id: (r.target_user_id as string | null) ?? null,
        target: (r.target as string | null) ?? null,
        payload: (r.payload as Record<string, unknown> | null) ?? null,
        created_at: String(r.created_at),
      }))
    : [];

  return { kind: 'ok', rows, page };
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams?: { page?: string };
}) {
  const page = Number.parseInt(searchParams?.page ?? '0', 10) || 0;
  const data = await loadLog(page);
  if (data.kind === 'unconfigured') notFound();
  if (data.kind === 'forbidden') redirect('/');

  const { rows } = data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h1 className="font-mono text-3xl font-bold tracking-tight">Audit log</h1>
          <Link href="/admin" className="text-xs text-neutral-400 hover:text-neutral-200">
            ← back to admin
          </Link>
        </div>
        <p className="text-sm text-neutral-400">
          Append-only trail of every admin action. UPDATE + DELETE rejected by trigger.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Last 50 actions · page {page + 1}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-neutral-400">No actions logged on this page.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Actor</th>
                  <th className="px-3 py-2 text-left">Action</th>
                  <th className="px-3 py-2 text-left">Target</th>
                  <th className="px-3 py-2 text-left">Payload</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-900">
                    <td className="px-3 py-2 text-xs text-neutral-400">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <div className="flex flex-col">
                        <span className="font-mono text-neutral-200">
                          {r.actor_handle ?? '—'}
                        </span>
                        <span className="text-xs text-neutral-500">{r.actor_email ?? ''}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-sky-300">{r.action}</td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-400">
                      {r.target ?? r.target_user_id ?? ''}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-400">
                      {r.payload ? JSON.stringify(r.payload) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        {page > 0 ? (
          <Link
            href={`/admin/audit?page=${page - 1}`}
            className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            ← newer
          </Link>
        ) : (
          <span />
        )}
        {rows.length === 50 && (
          <Link
            href={`/admin/audit?page=${page + 1}`}
            className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            older →
          </Link>
        )}
      </div>
    </main>
  );
}
