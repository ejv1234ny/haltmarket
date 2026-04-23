// Server-only helper: read USDC balances on Base via viem. Used by the
// admin reconciliation panel to compare ledger custody to real on-chain
// holdings in the hot + cold Safe wallets.

import 'server-only';
import { createPublicClient, http, erc20Abi, type Address } from 'viem';
import { base } from 'viem/chains';

const USDC_BASE =
  (process.env.USDC_BASE_ADDRESS as Address | undefined) ??
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Base USDC uses 6 decimals; our ledger uses 6-decimal micros, so raw is
// directly usable as micros.
function clientOrNull() {
  try {
    return createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
    });
  } catch (e) {
    console.error('base publicClient init failed', e);
    return null;
  }
}

export async function usdcBalanceMicros(address: string): Promise<bigint | null> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const client = clientOrNull();
  if (!client) return null;
  try {
    const raw = await client.readContract({
      address: USDC_BASE,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address as Address],
    });
    return raw;
  } catch (e) {
    console.error('usdcBalanceMicros read failed', e);
    return null;
  }
}

export interface SafeBalances {
  hotMicros: bigint | null;
  coldMicros: bigint | null;
  totalMicros: bigint | null;
}

export async function safeBalancesMicros(): Promise<SafeBalances> {
  const hot = process.env.HOT_WALLET_ADDRESS ?? '';
  const cold = process.env.COLD_WALLET_ADDRESS ?? '';
  const [hotMicros, coldMicros] = await Promise.all([
    hot ? usdcBalanceMicros(hot) : Promise.resolve(null),
    cold ? usdcBalanceMicros(cold) : Promise.resolve(null),
  ]);
  const totalMicros =
    hotMicros !== null && coldMicros !== null
      ? hotMicros + coldMicros
      : hotMicros !== null
        ? hotMicros
        : coldMicros;
  return { hotMicros, coldMicros, totalMicros };
}
