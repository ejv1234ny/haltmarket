'use client';

import { useCallback, useState } from 'react';
import { useUserEvents } from '@/lib/data';
import { formatUsd } from '@/lib/format';

export function WalletBalance({ userId, initialMicro }: { userId: string; initialMicro: number }) {
  const [balance, setBalance] = useState(initialMicro);

  useUserEvents(
    userId,
    useCallback((ev) => {
      if (ev.type === 'wallet') setBalance(ev.balance_micro);
    }, []),
  );

  return (
    <span className="font-mono text-4xl font-semibold text-neutral-50" data-testid="wallet-balance">
      {formatUsd(balance)}
    </span>
  );
}
