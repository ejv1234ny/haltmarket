// @haltmarket/ledger-client — typed wrapper around the Phase 1 ledger RPC layer.
//
// The ledger itself (`public.post_transfer` etc.) lives in
// supabase/migrations/0001_ledger.sql and is documented in ADR-0001. This
// package is the *only* way application code should move money: it serializes
// legs, invokes the RPC, and surfaces typed errors so callers can distinguish
// overdraft from duplicate-idempotency-key without string-matching.

import type { Currency, LedgerAccount } from '@haltmarket/shared-types';

export type { Currency, LedgerAccount };

export interface TransferLeg {
  /** auth.users.id; null for pool accounts (market_pool, house_fees). */
  userId: string | null;
  account: LedgerAccount;
  currency: Currency;
  /** Signed integer micros. Must be non-zero. Sum across legs must equal 0n. */
  amountMicro: bigint;
  refMarketId?: string | null;
  refBetId?: string | null;
}

export interface PostTransferInput {
  /**
   * Caller-generated UUID that identifies this transfer. Re-submitting the
   * same txn_id rejects with DuplicateTxnError (see ADR-0001 §Decision).
   * Callers wanting at-most-once semantics must persist the UUID before
   * calling postTransfer.
   */
  txnId: string;
  legs: TransferLeg[];
  reason: string;
}

export type LedgerErrorCode =
  | 'duplicate_txn_id'
  | 'unbalanced_legs'
  | 'invalid_leg'
  | 'overdraft'
  | 'transport';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  override readonly cause?: unknown;
  constructor(code: LedgerErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Minimum surface we need from a Supabase client. Implementations (real
 * `@supabase/supabase-js`, or fakes in tests) only have to provide `.rpc()`.
 */
export interface LedgerRpcClient {
  rpc(
    fn: 'post_transfer',
    args: { p_txn_id: string; p_legs: unknown; p_reason: string },
  ): Promise<{ error: PostgrestLikeError | null }>;
}

export interface PostgrestLikeError {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface LedgerClient {
  postTransfer(input: PostTransferInput): Promise<void>;
}

/**
 * Sums leg amounts and throws LedgerError('unbalanced_legs') if the sum is
 * non-zero. Exported so edge functions can fail fast before the RPC round-trip.
 */
export function assertLegsBalance(legs: TransferLeg[]): void {
  if (legs.length < 2) {
    throw new LedgerError(
      'invalid_leg',
      `legs must contain at least 2 entries, got ${legs.length}`,
    );
  }
  let sum = 0n;
  for (const leg of legs) {
    if (leg.amountMicro === 0n) {
      throw new LedgerError('invalid_leg', 'leg amountMicro must be non-zero');
    }
    if (leg.account === 'user_wallet' && !leg.userId) {
      throw new LedgerError(
        'invalid_leg',
        'user_wallet leg requires userId',
      );
    }
    sum += leg.amountMicro;
  }
  if (sum !== 0n) {
    throw new LedgerError(
      'unbalanced_legs',
      `ledger legs do not sum to zero: ${sum.toString()}`,
    );
  }
}

/**
 * Converts TransferLeg[] into the JSON shape expected by the `post_transfer`
 * plpgsql function. bigint → string so the JSON layer can carry full precision.
 */
export function serializeLegs(legs: TransferLeg[]): unknown[] {
  return legs.map((leg) => {
    const payload: Record<string, unknown> = {
      account: leg.account,
      currency: leg.currency,
      amount_micro: leg.amountMicro.toString(),
    };
    if (leg.userId) payload.user_id = leg.userId;
    if (leg.refMarketId) payload.ref_market_id = leg.refMarketId;
    if (leg.refBetId) payload.ref_bet_id = leg.refBetId;
    return payload;
  });
}

/**
 * Maps the Postgres SQLSTATE or message fragment returned by post_transfer
 * into a structured LedgerErrorCode.
 *
 * Postgres codes used in 0001_ledger.sql:
 *   23505 unique_violation      — duplicate txn_id
 *   23514 check_violation       — unbalanced legs OR overdraft
 *   22004 null_value_not_allowed / 22023 invalid_parameter_value — bad leg shape
 */
export function classifyPostTransferError(err: PostgrestLikeError): LedgerError {
  const code = err.code ?? '';
  const msg = err.message ?? '';
  if (code === '23505' || /duplicate/i.test(msg)) {
    return new LedgerError('duplicate_txn_id', msg, err);
  }
  if (code === '23514') {
    if (/sum to zero/i.test(msg)) {
      return new LedgerError('unbalanced_legs', msg, err);
    }
    if (/negative/i.test(msg)) {
      return new LedgerError('overdraft', msg, err);
    }
    return new LedgerError('unbalanced_legs', msg, err);
  }
  if (code === '22004' || code === '22023') {
    return new LedgerError('invalid_leg', msg, err);
  }
  return new LedgerError('transport', msg || 'post_transfer RPC failed', err);
}

/**
 * Canonical transfer builders. Every money movement in haltmarket goes through
 * one of these — never hand-assembled legs in hot-path code. Matches the five
 * patterns in ADR-0001 appendix + the withdrawal pattern.
 */
export const transfers = {
  deposit(params: {
    userId: string;
    currency: Currency;
    amountMicro: bigint;
  }): TransferLeg[] {
    const { userId, currency, amountMicro } = params;
    if (amountMicro <= 0n) {
      throw new LedgerError('invalid_leg', 'deposit amountMicro must be > 0');
    }
    return [
      { userId, account: 'user_wallet', currency, amountMicro },
      {
        userId,
        account: 'pending_deposits',
        currency,
        amountMicro: -amountMicro,
      },
    ];
  },

  betPlacement(params: {
    userId: string;
    marketId: string;
    betId?: string;
    currency: Currency;
    stakeMicro: bigint;
  }): TransferLeg[] {
    const { userId, marketId, betId, currency, stakeMicro } = params;
    if (stakeMicro <= 0n) {
      throw new LedgerError('invalid_leg', 'stakeMicro must be > 0');
    }
    return [
      {
        userId,
        account: 'user_wallet',
        currency,
        amountMicro: -stakeMicro,
        refMarketId: marketId,
        refBetId: betId ?? null,
      },
      {
        userId: null,
        account: 'market_pool',
        currency,
        amountMicro: stakeMicro,
        refMarketId: marketId,
        refBetId: betId ?? null,
      },
    ];
  },

  betRefund(params: {
    userId: string;
    marketId: string;
    betId?: string;
    currency: Currency;
    amountMicro: bigint;
  }): TransferLeg[] {
    const { userId, marketId, betId, currency, amountMicro } = params;
    if (amountMicro <= 0n) {
      throw new LedgerError('invalid_leg', 'refund amountMicro must be > 0');
    }
    return [
      {
        userId: null,
        account: 'market_pool',
        currency,
        amountMicro: -amountMicro,
        refMarketId: marketId,
        refBetId: betId ?? null,
      },
      {
        userId,
        account: 'user_wallet',
        currency,
        amountMicro,
        refMarketId: marketId,
        refBetId: betId ?? null,
      },
    ];
  },

  winnerPayout(params: {
    userId: string;
    marketId: string;
    betId?: string;
    currency: Currency;
    amountMicro: bigint;
  }): TransferLeg[] {
    const { userId, marketId, betId, currency, amountMicro } = params;
    if (amountMicro <= 0n) {
      throw new LedgerError('invalid_leg', 'payout amountMicro must be > 0');
    }
    return [
      {
        userId: null,
        account: 'market_pool',
        currency,
        amountMicro: -amountMicro,
        refMarketId: marketId,
        refBetId: betId ?? null,
      },
      {
        userId,
        account: 'user_wallet',
        currency,
        amountMicro,
        refMarketId: marketId,
        refBetId: betId ?? null,
      },
    ];
  },

  houseFee(params: {
    marketId: string;
    currency: Currency;
    amountMicro: bigint;
  }): TransferLeg[] {
    const { marketId, currency, amountMicro } = params;
    if (amountMicro <= 0n) {
      throw new LedgerError('invalid_leg', 'fee amountMicro must be > 0');
    }
    return [
      {
        userId: null,
        account: 'market_pool',
        currency,
        amountMicro: -amountMicro,
        refMarketId: marketId,
      },
      {
        userId: null,
        account: 'house_fees',
        currency,
        amountMicro,
        refMarketId: marketId,
      },
    ];
  },

  withdrawal(params: {
    userId: string;
    currency: Currency;
    amountMicro: bigint;
  }): TransferLeg[] {
    const { userId, currency, amountMicro } = params;
    if (amountMicro <= 0n) {
      throw new LedgerError(
        'invalid_leg',
        'withdrawal amountMicro must be > 0',
      );
    }
    return [
      {
        userId,
        account: 'user_wallet',
        currency,
        amountMicro: -amountMicro,
      },
      {
        userId,
        account: 'pending_withdrawals',
        currency,
        amountMicro,
      },
    ];
  },
};

/**
 * Creates a LedgerClient backed by a supabase-js (or compatible) RPC caller.
 * The returned postTransfer validates legs client-side and classifies errors
 * into a typed LedgerError so hot-path code can branch on `.code`.
 */
export function createLedgerClient(rpc: LedgerRpcClient): LedgerClient {
  return {
    async postTransfer(input: PostTransferInput): Promise<void> {
      if (!input.txnId) {
        throw new LedgerError('invalid_leg', 'txnId is required');
      }
      if (!input.reason || input.reason.trim().length === 0) {
        throw new LedgerError('invalid_leg', 'reason is required');
      }
      assertLegsBalance(input.legs);

      const { error } = await rpc.rpc('post_transfer', {
        p_txn_id: input.txnId,
        p_legs: serializeLegs(input.legs),
        p_reason: input.reason,
      });
      if (error) {
        throw classifyPostTransferError(error);
      }
    },
  };
}
