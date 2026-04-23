'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUsd } from '@/lib/format';
import { ignoreOrphanAction, rescueOrphanAction } from './actions';

interface Row {
  id: string;
  tx_hash: string;
  from_address: string;
  amount_micro: number;
  age_seconds: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function OrphanRow({ row }: { row: Row }) {
  const [mode, setMode] = useState<'idle' | 'bind' | 'ignore'>('idle');
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!UUID_RE.test(userId)) {
      setError('user_id must be a UUID');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await rescueOrphanAction(row.id, userId);
      if (!res.ok) setError(res.error ?? 'failed');
      else setMode('idle');
    });
  }

  function submitIgnore(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError('reason required (>=3 chars)');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await ignoreOrphanAction(row.id, reason);
      if (!res.ok) setError(res.error ?? 'failed');
      else setMode('idle');
    });
  }

  return (
    <tr className="border-b border-neutral-900">
      <td className="px-3 py-2 font-mono text-xs">
        {row.tx_hash.slice(0, 10)}…{row.tx_hash.slice(-4)}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {row.from_address.slice(0, 8)}…{row.from_address.slice(-4)}
      </td>
      <td className="px-3 py-2 font-mono">{formatUsd(row.amount_micro)}</td>
      <td className="px-3 py-2 text-xs text-neutral-400">
        {Math.floor(row.age_seconds / 60)}m
      </td>
      <td className="px-3 py-2">
        {mode === 'idle' && (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => setMode('bind')}>
              Bind + credit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode('ignore')}>
              Ignore
            </Button>
          </div>
        )}
        {mode === 'bind' && (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <Input
              value={userId}
              onChange={(e) => setUserId(e.target.value.trim())}
              placeholder="target user_id (uuid)"
              className="text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={pending}>
                {pending ? '…' : 'Confirm'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => setMode('idle')}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {mode === 'ignore' && (
          <form onSubmit={submitIgnore} className="flex flex-col gap-2">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="why ignore?"
              className="text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="submit" disabled={pending}>
                {pending ? '…' : 'Ignore'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => setMode('idle')}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </td>
    </tr>
  );
}
