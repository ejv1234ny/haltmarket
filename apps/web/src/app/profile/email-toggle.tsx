'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { setEmailNotifyAction } from './actions';

export function EmailNotifyToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !enabled;
    setError(null);
    startTransition(async () => {
      const res = await setEmailNotifyAction(next);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setEnabled(next);
    });
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex flex-col">
        <span className="text-sm font-medium">Email me on new halts</span>
        <span className="text-xs text-neutral-500">
          One email per new LUDP halt. Unsubscribe here any time.
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          variant={enabled ? 'outline' : 'primary'}
          onClick={toggle}
          disabled={pending}
          data-testid="email-notify-toggle"
        >
          {pending ? '…' : enabled ? 'Turn off' : 'Turn on'}
        </Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
