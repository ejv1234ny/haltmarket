'use client';

import { getBrowserSupabase } from '../supabase/browser';
import { env, supabaseConfigured } from '../env';

export type WithdrawalErrorCode =
  | 'withdrawals_frozen'
  | 'withdrawal_below_min'
  | 'invalid_address'
  | 'insufficient_balance'
  | 'unauthorized'
  | 'network_error'
  | 'internal_error';

export interface WithdrawalSuccess {
  ok: true;
  withdrawal_id: string;
}

export interface WithdrawalFailure {
  ok: false;
  code: WithdrawalErrorCode;
  message: string;
}

export type WithdrawalResult = WithdrawalSuccess | WithdrawalFailure;

export interface RequestWithdrawalInput {
  amountMicro: bigint;
  destinationAddress: string;
  chainId?: number;
}

export async function requestWithdrawal(
  input: RequestWithdrawalInput,
): Promise<WithdrawalResult> {
  if (!supabaseConfigured) {
    return {
      ok: false,
      code: 'internal_error',
      message: 'Supabase is not configured in this environment.',
    };
  }
  const supabase = getBrowserSupabase();
  if (!supabase) {
    return { ok: false, code: 'internal_error', message: 'supabase client unavailable' };
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    return { ok: false, code: 'unauthorized', message: 'sign in to withdraw' };
  }

  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/request-withdrawal`;
  const body = {
    amount_micro: input.amountMicro.toString(),
    destination_address: input.destinationAddress,
    chain_id: input.chainId ?? 8453,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      message: (e as Error).message || 'request failed',
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return {
      ok: false,
      code: 'internal_error',
      message: `non-JSON response (${res.status})`,
    };
  }

  if (res.ok) {
    const p = payload as { withdrawal_id: string };
    return { ok: true, withdrawal_id: p.withdrawal_id };
  }

  const err = payload as { error?: string; message?: string };
  return {
    ok: false,
    code: (err.error as WithdrawalErrorCode) ?? 'internal_error',
    message: err.message ?? `HTTP ${res.status}`,
  };
}

const USER_MESSAGES: Record<WithdrawalErrorCode, string> = {
  withdrawals_frozen: 'Withdrawals are temporarily paused.',
  withdrawal_below_min: 'Amount is below the $5 minimum.',
  invalid_address: 'Destination address is not a valid Base address.',
  insufficient_balance: 'Your wallet balance is lower than the amount.',
  unauthorized: 'Sign in to withdraw.',
  network_error: 'Network error. Try again.',
  internal_error: 'Something went wrong. Try again.',
};

export function withdrawalMessageFor(code: WithdrawalErrorCode): string {
  return USER_MESSAGES[code] ?? USER_MESSAGES.internal_error;
}
