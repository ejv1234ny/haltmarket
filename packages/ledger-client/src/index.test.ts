import { describe, expect, it } from 'vitest';
import { assertLegsBalance, type TransferLeg } from './index.js';

describe('assertLegsBalance', () => {
  it('accepts balanced legs', () => {
    const legs: TransferLeg[] = [
      { userId: 'a', account: 'user_wallet', currency: 'USDC', amountMicro: -10n },
      { userId: null, account: 'market_pool', currency: 'USDC', amountMicro: 10n },
    ];
    expect(() => assertLegsBalance(legs)).not.toThrow();
  });

  it('rejects unbalanced legs', () => {
    const legs: TransferLeg[] = [
      { userId: 'a', account: 'user_wallet', currency: 'USDC', amountMicro: -10n },
      { userId: null, account: 'market_pool', currency: 'USDC', amountMicro: 9n },
    ];
    expect(() => assertLegsBalance(legs)).toThrow(/sum to zero/);
  });
});
