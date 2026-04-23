'use client';

import { useEffect, useState } from 'react';
import { formatUsd } from '@/lib/format';
import { userChannel } from '@/lib/mocks/realtime';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { supabaseConfigured } from '@/lib/env';

export function WalletBalance({ userId, initialMicro }: { userId: string; initialMicro: number }) {
  const [balance, setBalance] = useState(initialMicro);

  useEffect(() => {
    // Demo/test mode — use the in-memory mock channel so the existing
    // Playwright smoke keeps its optimistic-update flow.
    if (!supabaseConfigured) {
      const unsub = userChannel(userId).subscribe((ev) => {
        if (ev.type === 'wallet') setBalance(ev.balance_micro);
      });
      return unsub;
    }

    // Real mode — subscribe to postgres_changes on public.wallets filtered
    // by user_id. RLS (wallets_select_own) restricts the subscription to
    // this user's rows, and the supabase_realtime publication is populated
    // by migration 0012. user_wallet USDC is the only row we care about.
    const supabase = getBrowserSupabase();
    if (!supabase) return;

    const channel = supabase
      .channel(`wallet:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = (payload.new ?? payload.old) as {
            account?: string;
            currency?: string;
            balance_micro?: number | string | null;
          } | null;
          if (!row) return;
          if (row.account !== 'user_wallet' || row.currency !== 'USDC') return;
          if (row.balance_micro == null) return;
          setBalance(Number(row.balance_micro));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return (
    <span className="font-mono text-4xl font-semibold text-neutral-50" data-testid="wallet-balance">
      {formatUsd(balance)}
    </span>
  );
}
