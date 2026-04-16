// Ledger-client stub. Full implementation lands in Phase 1 (see ADR-0001).
// Surface the transfer-leg shape now so downstream callers can compile against it.

import type { Currency, LedgerAccount } from '@haltmarket/shared-types';

export interface TransferLeg {
  userId: string | null;
  account: LedgerAccount;
  currency: Currency;
  amountMicro: bigint;
  refMarketId?: string | null;
  refBetId?: string | null;
}

export interface PostTransferInput {
  txnId: string;
  legs: TransferLeg[];
  reason: string;
}

export interface LedgerClient {
  postTransfer(input: PostTransferInput): Promise<void>;
}

export function assertLegsBalance(legs: TransferLeg[]): void {
  const sum = legs.reduce((acc, leg) => acc + leg.amountMicro, 0n);
  if (sum !== 0n) {
    throw new Error(`ledger legs do not sum to zero: ${sum.toString()}`);
  }
}
