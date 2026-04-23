'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUsd } from '@/lib/format';
import { rescueOrphanAction } from './actions';

interface Row {
  id: string;
  tx_hash: string;
  from_address: string;
  amount_micro: number;
  age_seconds: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function OrphanRow({ row }: { row: Row }) {
  const [mode, setMode] = useState<'idle' | 'bind'>('idle');
  const [userId, setUserId] = useState('');
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
        {mode === 'idle' ? (
          <Button size="sm" variant="primary" onClick={() => setMode('bind')}>
            Bind + credit
          </Button>
        ) : (
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
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </td>
    </tr>
  );
}
