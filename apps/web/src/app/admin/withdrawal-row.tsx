'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUsd } from '@/lib/format';
import {
  markWithdrawalFailedAction,
  markWithdrawalPaidAction,
} from './actions';

interface Row {
  id: string;
  handle: string | null;
  amount_micro: number;
  destination_address: string;
  age_seconds: number;
}

export function WithdrawalRow({ row }: { row: Row }) {
  const [mode, setMode] = useState<'idle' | 'pay' | 'fail'>('idle');
  const [txHash, setTxHash] = useState('');
  const [blockNumber, setBlockNumber] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submitPaid(e: React.FormEvent) {
    e.preventDefault();
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      setError('tx hash must be 0x + 64 hex');
      return;
    }
    const block = Number.parseInt(blockNumber || '0', 10);
    if (!Number.isFinite(block) || block <= 0) {
      setError('block number must be a positive integer');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await markWithdrawalPaidAction(row.id, txHash, block);
      if (!res.ok) setError(res.error ?? 'failed');
      else setMode('idle');
    });
  }

  function submitFailed(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError('reason required');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await markWithdrawalFailedAction(row.id, reason);
      if (!res.ok) setError(res.error ?? 'failed');
      else setMode('idle');
    });
  }

  return (
    <tr className="border-b border-neutral-900">
      <td className="px-3 py-2 font-mono text-xs">{row.handle ?? row.id.slice(0, 8)}</td>
      <td className="px-3 py-2 font-mono">{formatUsd(row.amount_micro)}</td>
      <td className="px-3 py-2 font-mono text-xs">
        {row.destination_address.slice(0, 8)}…{row.destination_address.slice(-4)}
      </td>
      <td className="px-3 py-2 text-xs text-neutral-400">
        {Math.floor(row.age_seconds / 60)}m
      </td>
      <td className="px-3 py-2">
        {mode === 'idle' && (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => setMode('pay')}>
              Mark paid
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode('fail')}>
              Mark failed
            </Button>
          </div>
        )}
        {mode === 'pay' && (
          <form onSubmit={submitPaid} className="flex flex-col gap-2">
            <Input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value.trim())}
              placeholder="tx hash (0x…)"
              className="text-xs"
            />
            <Input
              value={blockNumber}
              onChange={(e) => setBlockNumber(e.target.value.trim())}
              placeholder="block number"
              className="text-xs"
              type="number"
            />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={pending}>
                {pending ? '…' : 'Confirm'}
              </Button>
              <Button size="sm" variant="outline" type="button" onClick={() => setMode('idle')}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {mode === 'fail' && (
          <form onSubmit={submitFailed} className="flex flex-col gap-2">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reason"
              className="text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="submit" disabled={pending}>
                {pending ? '…' : 'Record failure'}
              </Button>
              <Button size="sm" variant="outline" type="button" onClick={() => setMode('idle')}>
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
