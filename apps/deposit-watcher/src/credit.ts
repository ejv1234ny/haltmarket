import { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from './logger.js';
import { depositsCreditedTotal, rpcLatencyMs } from './metrics.js';

/**
 * Known-outcome error codes returned by credit_crypto_deposit.
 * See supabase/migrations/0008_crypto_rail.sql for the full list.
 */
export const CRYPTO_ERROR_CODES = {
  H0012: 'crypto_deposit_cap_exceeded',
  H0013: 'crypto_duplicate_txhash',
  H0014: 'crypto_unknown_sender',
  H0015: 'crypto_deposits_frozen',
} as const;

export type CreditInput = {
  chainId: number;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amountMicro: bigint;
  blockNumber: bigint;
};

export type CreditOutcome =
  | { kind: 'credited'; depositId: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'rejected'; code: keyof typeof CRYPTO_ERROR_CODES | string; message: string };

/**
 * Call credit_crypto_deposit RPC. Returns a discriminated union so the caller
 * can distinguish retryable failures from permanent ones without parsing
 * PostgreSQL error strings.
 */
export async function creditDeposit(
  supabase: SupabaseClient,
  log: Logger,
  input: CreditInput
): Promise<CreditOutcome> {
  const start = Date.now();

  const { data, error } = await supabase.rpc('credit_crypto_deposit', {
    p_chain_id:     input.chainId,
    p_tx_hash:      input.txHash,
    p_from_address: input.fromAddress,
    p_to_address:   input.toAddress,
    p_amount_micro: input.amountMicro.toString(),   // bigint -> text for Postgres
    p_block_number: input.blockNumber.toString(),
  });

  rpcLatencyMs.observe(Date.now() - start);

  if (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    const known = code in CRYPTO_ERROR_CODES;
    const message = error.message ?? 'rpc error';

    if (known) {
      log.warn('credit_crypto_deposit rejected', {
        code,
        label: CRYPTO_ERROR_CODES[code as keyof typeof CRYPTO_ERROR_CODES],
        txHash: input.txHash,
        fromAddress: input.fromAddress,
      });
      depositsCreditedTotal.inc({ status: 'rejected' });

      // H0014 (unknown sender) is the one rejection we persist, so admins can
      // rescue the deposit via /admin/orphans. Best-effort — if the orphan
      // record also fails, we log and continue.
      if (code === 'H0014') {
        const orphanRes = await supabase.rpc('record_orphan_deposit', {
          p_chain_id: input.chainId,
          p_tx_hash: input.txHash,
          p_from_address: input.fromAddress,
          p_to_address: input.toAddress,
          p_amount_micro: input.amountMicro.toString(),
          p_block_number: input.blockNumber.toString(),
        });
        if (orphanRes.error) {
          log.error('record_orphan_deposit failed', {
            code: (orphanRes.error as { code?: string }).code,
            message: orphanRes.error.message,
            txHash: input.txHash,
          });
        } else {
          log.info('orphan deposit recorded for admin rescue', {
            txHash: input.txHash,
            fromAddress: input.fromAddress,
            orphanId: typeof orphanRes.data === 'string' ? orphanRes.data : String(orphanRes.data ?? ''),
          });
        }
      }

      return { kind: 'rejected', code, message };
    }

    // Unknown errors are retryable from Alchemy's perspective (we return 500).
    log.error('credit_crypto_deposit unexpected error', {
      code,
      message,
      txHash: input.txHash,
    });
    depositsCreditedTotal.inc({ status: 'errored' });
    throw error;
  }

  const depositId = typeof data === 'string' ? data : String(data ?? '');
  log.info('deposit credited', {
    depositId,
    txHash: input.txHash,
    fromAddress: input.fromAddress,
    amountMicro: input.amountMicro.toString(),
  });
  depositsCreditedTotal.inc({ status: 'credited' });
  return { kind: 'credited', depositId };
}
