// Wallet balance + recent ledger reads. RLS on Phase 1's `wallets` +
// `ledger_entries` tables scopes rows to `auth.uid() = user_id`, so the
// server-side anon client returns only the signed-in user's data.

import { getServerSupabase } from '../supabase/server';
import { supabaseConfigured } from '../env';
import { FIXTURE_LEDGER, FIXTURE_WALLET } from './fixtures';
import type { LedgerEntry, Wallet } from './types';

interface WalletRow {
  user_id: string;
  account: string;
  currency: string;
  balance_micro: number | string;
}

interface LedgerEntryRow {
  id: number | string;
  txn_id: string;
  account: string;
  currency: string;
  amount_micro: number | string;
  reason: string;
  created_at: string;
}

export async function getWalletForUser(userId: string): Promise<Wallet> {
  if (!supabaseConfigured) return FIXTURE_WALLET;
  const client = getServerSupabase();
  if (!client) return FIXTURE_WALLET;

  const { data, error } = await client
    .from('wallets')
    .select('user_id, account, currency, balance_micro')
    .eq('user_id', userId)
    .eq('account', 'user_wallet')
    .eq('currency', 'USDC')
    .maybeSingle();
  if (error) throw new Error(`wallet query failed: ${error.message}`);

  if (!data) {
    return { user_id: userId, currency: 'USDC', balance_micro: 0 };
  }
  const row = data as WalletRow;
  return {
    user_id: row.user_id,
    currency: row.currency as Wallet['currency'],
    balance_micro: Number(row.balance_micro),
  };
}

export async function listRecentLedger(userId: string): Promise<LedgerEntry[]> {
  if (!supabaseConfigured) return FIXTURE_LEDGER;
  const client = getServerSupabase();
  if (!client) return FIXTURE_LEDGER;

  const { data, error } = await client
    .from('ledger_entries')
    .select('id, txn_id, account, currency, amount_micro, reason, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(`ledger_entries query failed: ${error.message}`);

  return (data ?? []).map((row: LedgerEntryRow): LedgerEntry => ({
    id: Number(row.id),
    txn_id: row.txn_id,
    account: row.account,
    amount_micro: Number(row.amount_micro),
    reason: row.reason,
    created_at: row.created_at,
  }));
}
