'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { setSystemFlagAction } from './actions';

interface Props {
  flag: string;
  value: boolean;
  label: string;
  note: string | null;
}

export function FlagToggle({ flag, value, label, note }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !value;
    const confirmText =
      next === true
        ? `Freeze ${label.toLowerCase()}? Users will see error states immediately.`
        : `Un-freeze ${label.toLowerCase()}?`;
    if (!window.confirm(confirmText)) return;
    setError(null);
    startTransition(async () => {
      const res = await setSystemFlagAction(flag, next);
      if (!res.ok) setError(res.error ?? 'failed');
    });
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-neutral-500">{note ?? flag}</span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant={value ? 'outline' : 'primary'}
          onClick={toggle}
          disabled={pending}
        >
          {pending ? '…' : value ? 'Un-freeze' : 'Freeze'}
        </Button>
        <span className={value ? 'text-xs text-red-400' : 'text-xs text-emerald-300'}>
          {value ? 'FROZEN' : 'live'}
        </span>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
