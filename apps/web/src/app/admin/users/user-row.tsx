'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { overrideKycAction, setUserAdminAction } from '../actions';

type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';

interface UserRow {
  user_id: string;
  email: string | null;
  handle: string | null;
  kyc_status: string | null;
  is_admin: boolean;
  created_at: string;
}

const KYC_OPTIONS: KycStatus[] = ['none', 'pending', 'approved', 'rejected'];

function kycCls(status: string | null): string {
  switch (status) {
    case 'approved':
      return 'bg-emerald-950/40 text-emerald-300';
    case 'pending':
      return 'bg-amber-950/40 text-amber-300';
    case 'rejected':
      return 'bg-red-950/40 text-red-300';
    default:
      return 'bg-neutral-900 text-neutral-400';
  }
}

export function UserRow({ row, currentUserId }: { row: UserRow; currentUserId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isSelf = row.user_id === currentUserId;

  function toggleAdmin() {
    const next = !row.is_admin;
    const confirmText = next
      ? `Grant admin to ${row.email ?? row.user_id}?`
      : `Revoke admin from ${row.email ?? row.user_id}?`;
    if (!window.confirm(confirmText)) return;
    setError(null);
    startTransition(async () => {
      const res = await setUserAdminAction(row.user_id, next);
      if (!res.ok) setError(res.error ?? 'failed');
    });
  }

  function setKyc(status: KycStatus) {
    if (status === row.kyc_status) return;
    setError(null);
    startTransition(async () => {
      const res = await overrideKycAction(row.user_id, status);
      if (!res.ok) setError(res.error ?? 'failed');
    });
  }

  return (
    <tr className="border-b border-neutral-900">
      <td className="px-3 py-2 text-sm">
        <div className="flex flex-col">
          <span className="font-mono text-neutral-200">
            {row.handle ?? <span className="text-neutral-500">—</span>}
          </span>
          <span className="text-xs text-neutral-500">{row.email ?? row.user_id.slice(0, 8)}</span>
        </div>
      </td>
      <td className="px-3 py-2 text-sm">
        <div className="flex items-center gap-1">
          <span className={`rounded-md px-2 py-0.5 text-xs ${kycCls(row.kyc_status)}`}>
            {row.kyc_status ?? 'none'}
          </span>
          <select
            value={row.kyc_status ?? 'none'}
            onChange={(e) => setKyc(e.target.value as KycStatus)}
            disabled={pending}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-1 py-0.5 text-xs text-neutral-200"
          >
            {KYC_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </td>
      <td className="px-3 py-2 text-sm">
        {row.is_admin ? (
          <span className="rounded-md bg-sky-950/40 px-2 py-0.5 text-xs text-sky-300">admin</span>
        ) : (
          <span className="text-xs text-neutral-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-neutral-500">
        {new Date(row.created_at).toLocaleDateString()}
      </td>
      <td className="px-3 py-2">
        <Button
          size="sm"
          variant={row.is_admin ? 'outline' : 'primary'}
          onClick={toggleAdmin}
          disabled={pending || isSelf}
          title={isSelf ? 'Cannot change your own admin flag' : ''}
        >
          {pending ? '…' : row.is_admin ? 'Revoke admin' : 'Grant admin'}
        </Button>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </td>
    </tr>
  );
}
