'use client';

import { useEffect } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

const BASE_CHAIN_ID = 8453;

const baseChain = {
  id: BASE_CHAIN_ID,
  name: 'Base',
  network: 'base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://mainnet.base.org'] },
    public: { http: ['https://mainnet.base.org'] },
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://basescan.org' },
  },
} as const;

interface Props {
  appId: string | null;
  children: ReactNode;
}

/**
 * Wraps the app with Privy so we get embedded Base wallets per user.
 *
 * When appId is null (dev without Privy keys), the provider is skipped and
 * children render unwrapped. The wallet page falls back to its mock/empty
 * state in that case.
 */
export function PrivyRoot({ appId, children }: Props) {
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'google'],
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' } },
        defaultChain: baseChain,
        supportedChains: [baseChain],
        appearance: { theme: 'dark', accentColor: '#22d3ee' },
      }}
    >
      <WalletSyncer />
      {children}
    </PrivyProvider>
  );
}

/**
 * Runs once Privy has provisioned an embedded wallet. POSTs the address to
 * /api/wallet-address so the server can map it to the Supabase user id via
 * the register_wallet_address RPC. Idempotent on (chain_id, address).
 */
function WalletSyncer() {
  const { authenticated, ready } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    if (!ready || !authenticated || wallets.length === 0) return;
    const embedded = wallets.find((w) => w.walletClientType === 'privy');
    if (!embedded) return;

    const controller = new AbortController();
    fetch('/api/wallet-address', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chain_id: BASE_CHAIN_ID,
        address: embedded.address,
        source: 'privy',
      }),
      signal: controller.signal,
    }).catch((e) => {
      if ((e as Error).name !== 'AbortError') {
        console.error('wallet-address sync failed', e);
      }
    });
    return () => controller.abort();
  }, [ready, authenticated, wallets]);

  return null;
}
