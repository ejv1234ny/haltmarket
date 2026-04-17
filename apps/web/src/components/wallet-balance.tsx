'use client';

import { useEffect, useState } from 'react';
import { formatUsd } from '@/lib/format';
import { userChannel } from '@/lib/mocks/realtime';

export function WalletBalance({ userId, initialMicro }: { userId: string; initialMicro: number }) {
  const [balance, setBalance] = useState(initialMicro);

  useEffect(() => {
    const unsub = userChannel(userId).subscribe((ev) => {
      if (ev.type === 'wallet') setBalance(ev.balance_micro);
    });
    return unsub;
  }, [userId]);

  return (
    <span className="font-mono text-4xl font-semibold text-neutral-50" data-testid="wallet-balance">
      {formatUsd(balance)}
    </span>
  );
}
