import { notFound, redirect } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUsd } from '@/lib/format';
import { getServerSupabase } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/env';
import { safeBalancesMicros } from '@/lib/onchain/balances';
import { FlagToggle } from './flag-toggle';
import { OrphanRow } from './orphan-row';
import { WithdrawalRow } from './withdrawal-row';

export const dynamic = 'force-dynamic';

interface FlagRow {
  flag: string;
  value: boolean;
  note: string | null;
}

interface QueueRow {
  id: string;
  handle: string | null;
  amount_micro: number;
  destination_address: string;
  age_seconds: number;
}

interface OrphanRowData {
  id: string;
  tx_hash: string;
  from_address: string;
  amount_micro: number;
  age_seconds: number;
}

interface ReconcileRow {
  ledger_custody_micro: number;
  in_flight_withdraw_micro: number;
  user_wallet_total_micro: number;
}

type RpcFn = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function loadAdminData(): Promise<
  | { kind: 'forbidden' }
  | { kind: 'unconfigured' }
  | {
      kind: 'ok';
      flags: FlagRow[];
      queue: QueueRow[];
      orphans: OrphanRowData[];
      reconcile: ReconcileRow | null;
      onChainMicros: bigint | null;
      hotMicros: bigint | null;
      coldMicros: bigint | null;
    }
> {
  if (!supabaseConfigured) return { kind: 'unconfigured' };
  const supabase = getServerSupabase();
  if (!supabase) return { kind: 'unconfigured' };

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { kind: 'forbidden' };

  const profileRes = await (supabase
    .from('user_profiles') as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: string) => {
          maybeSingle: () => Promise<{ data: { is_admin: boolean } | null }>;
        };
      };
    })
    .select('is_admin')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (!profileRes.data || profileRes.data.is_admin !== true) {
    return { kind: 'forbidden' };
  }

  const [
    { data: flagsRaw },
    queueRpc,
    orphansRpc,
    reconcileRpc,
    balances,
  ] = await Promise.all([
    supabase.from('system_flags').select('flag, value, note'),
    (supabase.rpc as unknown as RpcFn)('get_admin_withdrawal_queue'),
    (supabase.rpc as unknown as RpcFn)('admin_get_orphan_deposits'),
    (supabase.rpc as unknown as RpcFn)('reconcile_crypto_ledger'),
    safeBalancesMicros(),
  ]);

  const queue: QueueRow[] = Array.isArray(queueRpc.data)
    ? (queueRpc.data as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        handle: (r.handle as string | null) ?? null,
        amount_micro: Number(r.amount_micro),
        destination_address: String(r.destination_address),
        age_seconds: Number(r.age_seconds),
      }))
    : [];

  const orphans: OrphanRowData[] = Array.isArray(orphansRpc.data)
    ? (orphansRpc.data as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        tx_hash: String(r.tx_hash),
        from_address: String(r.from_address),
        amount_micro: Number(r.amount_micro),
        age_seconds: Number(r.age_seconds),
      }))
    : [];

  const reconcile: ReconcileRow | null =
    Array.isArray(reconcileRpc.data) && reconcileRpc.data.length > 0
      ? (() => {
          const r = reconcileRpc.data[0] as Record<string, unknown>;
          return {
            ledger_custody_micro: Number(r.ledger_custody_micro),
            in_flight_withdraw_micro: Number(r.in_flight_withdraw_micro),
            user_wallet_total_micro: Number(r.user_wallet_total_micro),
          };
        })()
      : null;

  return {
    kind: 'ok',
    flags: ((flagsRaw ?? []) as FlagRow[]).map((f) => ({
      flag: f.flag,
      value: f.value,
      note: f.note,
    })),
    queue,
    orphans,
    reconcile,
    onChainMicros: balances.totalMicros,
    hotMicros: balances.hotMicros,
    coldMicros: balances.coldMicros,
  };
}

function driftBadge(driftMicros: number) {
  const abs = Math.abs(driftMicros);
  if (abs < 1_000_000) return { label: 'OK', cls: 'text-emerald-300' };
  if (abs < 10_000_000) return { label: 'WARN', cls: 'text-amber-300' };
  return { label: 'CRITICAL', cls: 'text-red-300' };
}

export default async function AdminPage() {
  const data = await loadAdminData();

  if (data.kind === 'unconfigured') notFound();
  if (data.kind === 'forbidden') redirect('/');

  const { flags, queue, orphans, reconcile, onChainMicros, hotMicros, coldMicros } = data;

  const flagLabels: Record<string, string> = {
    deposits_frozen: 'Deposits',
    withdrawals_frozen: 'Withdrawals',
    markets_frozen: 'New markets',
  };

  let drift = 0;
  if (reconcile && onChainMicros !== null) {
    drift =
      Number(onChainMicros) -
      Math.abs(reconcile.ledger_custody_micro) -
      reconcile.in_flight_withdraw_micro;
  }
  const badge = driftBadge(drift);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h1 className="font-mono text-3xl font-bold tracking-tight">Admin</h1>
          <a
            href="/admin/users"
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            Users →
          </a>
        </div>
        <p className="text-sm text-neutral-400">
          Crypto rail controls. Freeze switches apply immediately on all services.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>System flags</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {flags.length === 0 && (
            <p className="text-xs text-neutral-400">No flags — apply migration 0008.</p>
          )}
          {flags.map((f) => (
            <FlagToggle
              key={f.flag}
              flag={f.flag}
              value={f.value}
              label={flagLabels[f.flag] ?? f.flag}
              note={f.note}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-4">
          <Stat
            label="Ledger custody"
            value={reconcile ? formatUsd(Math.abs(reconcile.ledger_custody_micro)) : '—'}
          />
          <Stat
            label="In-flight withdrawals"
            value={reconcile ? formatUsd(reconcile.in_flight_withdraw_micro) : '—'}
          />
          <Stat
            label="On-chain total"
            value={onChainMicros !== null ? formatUsd(Number(onChainMicros)) : 'env missing'}
            sub={
              hotMicros !== null && coldMicros !== null
                ? `hot ${formatUsd(Number(hotMicros))} · cold ${formatUsd(Number(coldMicros))}`
                : 'set HOT_WALLET_ADDRESS / COLD_WALLET_ADDRESS'
            }
          />
          <Stat
            label={`Drift (${badge.label})`}
            value={onChainMicros !== null && reconcile ? formatUsd(drift) : '—'}
            valueCls={badge.cls}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orphan deposits · {orphans.length}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {orphans.length === 0 ? (
            <p className="p-4 text-sm text-neutral-400">
              No orphan deposits. Unmapped senders get recorded here by the watcher.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">Tx</th>
                  <th className="px-3 py-2 text-left">From</th>
                  <th className="px-3 py-2 text-left">Amount</th>
                  <th className="px-3 py-2 text-left">Age</th>
                  <th className="px-3 py-2 text-left">Rescue</th>
                </tr>
              </thead>
              <tbody>
                {orphans.map((row) => (
                  <OrphanRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending withdrawal queue · {queue.length}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {queue.length === 0 ? (
            <p className="p-4 text-sm text-neutral-400">No pending withdrawals.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">User</th>
                  <th className="px-3 py-2 text-left">Amount</th>
                  <th className="px-3 py-2 text-left">Destination</th>
                  <th className="px-3 py-2 text-left">Age</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((row) => (
                  <WithdrawalRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({
  label,
  value,
  sub,
  valueCls,
}: {
  label: string;
  value: string;
  sub?: string;
  valueCls?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
      <span className="text-xs uppercase tracking-wide text-neutral-500">{label}</span>
      <span className={`font-mono text-lg ${valueCls ?? 'text-neutral-100'}`}>{value}</span>
      {sub && <span className="text-xs text-neutral-500">{sub}</span>}
    </div>
  );
}
