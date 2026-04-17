import { describe, expect, it, vi } from 'vitest';
import {
  assertLegsBalance,
  classifyPostTransferError,
  createLedgerClient,
  LedgerError,
  serializeLegs,
  transfers,
  type LedgerRpcClient,
  type TransferLeg,
} from './index.js';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const MARKET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TXN_ID = 'ffffffff-0000-0000-0000-000000000001';

describe('assertLegsBalance', () => {
  it('accepts balanced legs', () => {
    const legs: TransferLeg[] = [
      {
        userId: USER_A,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: -10n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 10n,
      },
    ];
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('rejects fewer than 2 legs', () => {
    expect(() =>
      assertLegsBalance([
        {
          userId: USER_A,
          account: 'user_wallet',
          currency: 'USDC',
          amountMicro: 1n,
        },
      ]),
    ).toThrow(/at least 2 entries/);
  });

  it('rejects zero-amount legs', () => {
    const legs: TransferLeg[] = [
      {
        userId: USER_A,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: 0n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 0n,
      },
    ];
    expect(() => assertLegsBalance(legs)).toThrow(/non-zero/);
  });

  it('rejects user_wallet leg without userId', () => {
    const legs: TransferLeg[] = [
      {
        userId: null,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: -10n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 10n,
      },
    ];
    expect(() => assertLegsBalance(legs)).toThrow(/userId/);
  });

  it('rejects unbalanced legs', () => {
    const legs: TransferLeg[] = [
      {
        userId: USER_A,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: -10n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 9n,
      },
    ];
    expect(() => assertLegsBalance(legs)).toThrow(/sum to zero/);
  });

  it('accepts N-leg balanced transfers (resolution scenario)', () => {
    const legs: TransferLeg[] = [
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: -1_000_000n,
      },
      {
        userId: null,
        account: 'house_fees',
        currency: 'USDC',
        amountMicro: 50_000n,
      },
      {
        userId: USER_A,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: 600_000n,
      },
      {
        userId: USER_B,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: 350_000n,
      },
    ];
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });
});

describe('canonical transfer patterns (ADR-0001 appendix)', () => {
  it('deposit: (+) user_wallet, (−) pending_deposits', () => {
    const legs = transfers.deposit({
      userId: USER_A,
      currency: 'USDC',
      amountMicro: 100_000_000n,
    });
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.account).sort()).toEqual([
      'pending_deposits',
      'user_wallet',
    ]);
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('bet placement: (−) user_wallet, (+) market_pool', () => {
    const legs = transfers.betPlacement({
      userId: USER_A,
      marketId: MARKET_ID,
      currency: 'USDC',
      stakeMicro: 10_000_000n,
    });
    expect(legs).toHaveLength(2);
    const userLeg = legs.find((l) => l.account === 'user_wallet');
    const poolLeg = legs.find((l) => l.account === 'market_pool');
    expect(userLeg?.amountMicro).toBe(-10_000_000n);
    expect(poolLeg?.amountMicro).toBe(10_000_000n);
    expect(poolLeg?.refMarketId).toBe(MARKET_ID);
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('bet refund: (−) market_pool, (+) user_wallet', () => {
    const legs = transfers.betRefund({
      userId: USER_A,
      marketId: MARKET_ID,
      currency: 'USDC',
      amountMicro: 5_000_000n,
    });
    expect(
      legs.find((l) => l.account === 'market_pool')?.amountMicro,
    ).toBe(-5_000_000n);
    expect(
      legs.find((l) => l.account === 'user_wallet')?.amountMicro,
    ).toBe(5_000_000n);
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('winner payout: (−) market_pool, (+) user_wallet', () => {
    const legs = transfers.winnerPayout({
      userId: USER_A,
      marketId: MARKET_ID,
      currency: 'USDC',
      amountMicro: 42_000_000n,
    });
    expect(legs).toHaveLength(2);
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('house fee: (−) market_pool, (+) house_fees', () => {
    const legs = transfers.houseFee({
      marketId: MARKET_ID,
      currency: 'USDC',
      amountMicro: 500_000n,
    });
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.userId === null)).toBe(true);
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('withdrawal: (−) user_wallet, (+) pending_withdrawals', () => {
    const legs = transfers.withdrawal({
      userId: USER_A,
      currency: 'USDC',
      amountMicro: 100_000_000n,
    });
    expect(legs).toHaveLength(2);
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('rejects zero/negative amounts on builders', () => {
    expect(() =>
      transfers.deposit({ userId: USER_A, currency: 'USDC', amountMicro: 0n }),
    ).toThrow();
    expect(() =>
      transfers.betPlacement({
        userId: USER_A,
        marketId: MARKET_ID,
        currency: 'USDC',
        stakeMicro: -1n,
      }),
    ).toThrow();
    expect(() =>
      transfers.houseFee({
        marketId: MARKET_ID,
        currency: 'USDC',
        amountMicro: 0n,
      }),
    ).toThrow();
    expect(() =>
      transfers.withdrawal({
        userId: USER_A,
        currency: 'USDC',
        amountMicro: -5n,
      }),
    ).toThrow();
    expect(() =>
      transfers.betRefund({
        userId: USER_A,
        marketId: MARKET_ID,
        currency: 'USDC',
        amountMicro: 0n,
      }),
    ).toThrow();
    expect(() =>
      transfers.winnerPayout({
        userId: USER_A,
        marketId: MARKET_ID,
        currency: 'USDC',
        amountMicro: 0n,
      }),
    ).toThrow();
  });
});

describe('serializeLegs', () => {
  it('converts bigint amounts to strings and omits empty refs', () => {
    const legs: TransferLeg[] = [
      {
        userId: USER_A,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: -12345n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 12345n,
        refMarketId: MARKET_ID,
      },
    ];
    const json = serializeLegs(legs);
    expect(json).toEqual([
      {
        account: 'user_wallet',
        currency: 'USDC',
        amount_micro: '-12345',
        user_id: USER_A,
      },
      {
        account: 'market_pool',
        currency: 'USDC',
        amount_micro: '12345',
        ref_market_id: MARKET_ID,
      },
    ]);
  });
});

describe('classifyPostTransferError', () => {
  it('maps unique_violation → duplicate_txn_id', () => {
    const err = classifyPostTransferError({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    });
    expect(err.code).toBe('duplicate_txn_id');
  });

  it('maps check_violation "sum to zero" → unbalanced_legs', () => {
    const err = classifyPostTransferError({
      code: '23514',
      message: 'legs do not sum to zero: 5',
    });
    expect(err.code).toBe('unbalanced_legs');
  });

  it('maps check_violation "negative" → overdraft', () => {
    const err = classifyPostTransferError({
      code: '23514',
      message: 'user_wallet balance would go negative (-100)',
    });
    expect(err.code).toBe('overdraft');
  });

  it('maps invalid_parameter_value → invalid_leg', () => {
    const err = classifyPostTransferError({
      code: '22023',
      message: 'legs must be a JSON array with at least 2 entries',
    });
    expect(err.code).toBe('invalid_leg');
  });

  it('falls back to transport on unknown SQLSTATE', () => {
    const err = classifyPostTransferError({
      code: '08006',
      message: 'connection failure',
    });
    expect(err.code).toBe('transport');
  });
});

describe('createLedgerClient', () => {
  const validLegs = transfers.betPlacement({
    userId: USER_A,
    marketId: MARKET_ID,
    currency: 'USDC',
    stakeMicro: 10_000_000n,
  });

  it('invokes RPC with serialized payload', async () => {
    const rpc: LedgerRpcClient = {
      rpc: vi.fn().mockResolvedValue({ error: null }),
    };
    const client = createLedgerClient(rpc);
    await client.postTransfer({
      txnId: TXN_ID,
      legs: validLegs,
      reason: 'bet:place',
    });
    expect(rpc.rpc).toHaveBeenCalledWith('post_transfer', {
      p_txn_id: TXN_ID,
      p_legs: serializeLegs(validLegs),
      p_reason: 'bet:place',
    });
  });

  it('throws LedgerError on missing txnId', async () => {
    const rpc: LedgerRpcClient = {
      rpc: vi.fn().mockResolvedValue({ error: null }),
    };
    const client = createLedgerClient(rpc);
    await expect(
      client.postTransfer({ txnId: '', legs: validLegs, reason: 'bet:place' }),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(rpc.rpc).not.toHaveBeenCalled();
  });

  it('throws LedgerError on empty reason', async () => {
    const rpc: LedgerRpcClient = {
      rpc: vi.fn().mockResolvedValue({ error: null }),
    };
    const client = createLedgerClient(rpc);
    await expect(
      client.postTransfer({ txnId: TXN_ID, legs: validLegs, reason: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_leg' });
    expect(rpc.rpc).not.toHaveBeenCalled();
  });

  it('classifies RPC errors into typed LedgerError', async () => {
    const rpc: LedgerRpcClient = {
      rpc: vi.fn().mockResolvedValue({
        error: {
          code: '23514',
          message: 'user_wallet balance would go negative (-100)',
        },
      }),
    };
    const client = createLedgerClient(rpc);
    await expect(
      client.postTransfer({
        txnId: TXN_ID,
        legs: validLegs,
        reason: 'bet:place',
      }),
    ).rejects.toMatchObject({ code: 'overdraft' });
  });

  it('short-circuits client-side on unbalanced legs (no RPC call)', async () => {
    const rpc: LedgerRpcClient = {
      rpc: vi.fn().mockResolvedValue({ error: null }),
    };
    const client = createLedgerClient(rpc);
    const bad: TransferLeg[] = [
      {
        userId: USER_A,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: -10n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 9n,
      },
    ];
    await expect(
      client.postTransfer({ txnId: TXN_ID, legs: bad, reason: 'bet:place' }),
    ).rejects.toMatchObject({ code: 'unbalanced_legs' });
    expect(rpc.rpc).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------
// Property-based: 10K random leg sequences preserve SUM = 0.
// This is a pure-arithmetic test on the TS side — it doesn't hit a DB.
// The DB-backed version lives in integration.test.ts and exercises
// post_transfer end-to-end.
// -------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: balanced N-leg transfers across random sequences', () => {
  it('10K randomly generated transfers each individually sum to 0 and the total sum stays 0', () => {
    const rand = mulberry32(0xc0ffee);
    let globalSum = 0n;
    for (let i = 0; i < 10_000; i++) {
      const nLegs = 2 + Math.floor(rand() * 4);
      const legs: TransferLeg[] = [];
      let sum = 0n;
      for (let j = 0; j < nLegs - 1; j++) {
        let amt = BigInt(Math.floor(rand() * 1_000_000) - 500_000);
        if (amt === 0n) amt = 1n;
        sum += amt;
        legs.push({
          userId: USER_A,
          account: 'user_wallet',
          currency: 'USDC',
          amountMicro: amt,
        });
      }
      if (sum === 0n) {
        // rare: closer would be zero. Append a balanced pair instead.
        legs.push({
          userId: USER_A,
          account: 'user_wallet',
          currency: 'USDC',
          amountMicro: 1n,
        });
        legs.push({
          userId: null,
          account: 'market_pool',
          currency: 'USDC',
          amountMicro: -1n,
        });
      } else {
        legs.push({
          userId: null,
          account: 'market_pool',
          currency: 'USDC',
          amountMicro: -sum,
        });
      }

      expect(() => assertLegsBalance(legs)).not.toThrow();
      for (const leg of legs) globalSum += leg.amountMicro;
    }
    expect(globalSum).toBe(0n);
  });
});
