'use server';

import { revalidatePath } from 'next/cache';
import { getServerSupabase } from '@/lib/supabase/server';

// Cast helper — the strongly-typed Database placeholder doesn't know about
// admin RPCs. They're SECURITY DEFINER with internal assert_is_admin() gates,
// so the cast only skips client-side typing, not server-side auth.
type RpcFn = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function setSystemFlagAction(
  flag: string,
  value: boolean,
  note?: string,
): Promise<ActionResult> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: 'supabase not configured' };
  const { error } = await (supabase.rpc as unknown as RpcFn)('set_system_flag', {
    p_flag: flag,
    p_value: value,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin');
  return { ok: true };
}

export async function markWithdrawalPaidAction(
  withdrawalId: string,
  txHash: string,
  blockNumber: number,
): Promise<ActionResult> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: 'supabase not configured' };
  const { error } = await (supabase.rpc as unknown as RpcFn)(
    'admin_mark_withdrawal_paid',
    {
      p_withdrawal_id: withdrawalId,
      p_tx_hash: txHash,
      p_block_number: blockNumber,
    },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin');
  return { ok: true };
}

export async function markWithdrawalFailedAction(
  withdrawalId: string,
  reason: string,
): Promise<ActionResult> {
  const supabase = getServerSupabase();
  if (!supabase) return { ok: false, error: 'supabase not configured' };
  const { error } = await (supabase.rpc as unknown as RpcFn)(
    'admin_mark_withdrawal_failed',
    { p_withdrawal_id: withdrawalId, p_reason: reason },
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath('/admin');
  return { ok: true };
}
