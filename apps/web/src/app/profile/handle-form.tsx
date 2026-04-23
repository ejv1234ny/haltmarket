'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setHandleAction } from './actions';

interface Props {
  initialHandle: string;
}

export function HandleForm({ initialHandle }: Props) {
  const [handle, setHandle] = useState(initialHandle);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const res = await setHandleAction(handle);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setSuccess(true);
    });
  }

  const dirty = handle.trim().toLowerCase() !== initialHandle;
  const valid = /^[a-z0-9_]{3,20}$/.test(handle.trim().toLowerCase());

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-400">Handle</span>
        <Input
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value);
            setSuccess(false);
          }}
          placeholder="3–20 lowercase chars, digits, or underscore"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-testid="handle-input"
        />
        <span className="text-xs text-neutral-500">
          Shown on the leaderboard and in shared results.
        </span>
      </label>

      {error && <p className="text-xs text-red-400" data-testid="handle-error">{error}</p>}
      {success && <p className="text-xs text-emerald-300" data-testid="handle-success">Saved.</p>}

      <Button
        type="submit"
        variant="primary"
        disabled={!dirty || !valid || pending}
        data-testid="handle-save"
      >
        {pending ? 'Saving…' : 'Save handle'}
      </Button>
    </form>
  );
}
