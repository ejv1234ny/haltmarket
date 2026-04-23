import { describe, expect, it, vi } from 'vitest';
import { creditDeposit, CRYPTO_ERROR_CODES } from '../src/credit.js';
import { Logger } from '../src/logger.js';

const log = new Logger('error');

function mockSupabase(rpcResult: { data: unknown; error: unknown }) {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as any;
}

describe('creditDeposit', () => {
  const input = {
    chainId:     8453,
    txHash:      '0x' + 'a'.repeat(64),
    fromAddress: '0x' + 'b'.repeat(40),
    toAddress:   '0x' + 'c'.repeat(40),
    amountMicro: 10_000_000n,  // $10
    blockNumber: 12345678n,
  };

  it('returns credited on success', async () => {
    const supabase = mockSupabase({ data: 'deposit-uuid', error: null });
    const outcome = await creditDeposit(supabase, log, input);
    expect(outcome.kind).toBe('credited');
    if (outcome.kind === 'credited') expect(outcome.depositId).toBe('deposit-uuid');
  });

  it('serializes bigints to strings for Postgres RPC params', async () => {
    const supabase = mockSupabase({ data: 'deposit-uuid', error: null });
    await creditDeposit(supabase, log, input);
    expect(supabase.rpc).toHaveBeenCalledWith('credit_crypto_deposit', expect.objectContaining({
      p_amount_micro: '10000000',
      p_block_number: '12345678',
    }));
  });

  it('maps known H-codes to rejected outcome', async () => {
    for (const code of Object.keys(CRYPTO_ERROR_CODES)) {
      const supabase = mockSupabase({ data: null, error: { code, message: 'nope' } });
      const outcome = await creditDeposit(supabase, log, input);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.code).toBe(code);
    }
  });

  it('throws on unknown errors so Alchemy retries', async () => {
    const supabase = mockSupabase({ data: null, error: { code: 'XX999', message: 'boom' } });
    await expect(creditDeposit(supabase, log, input)).rejects.toMatchObject({ message: 'boom' });
  });
});
