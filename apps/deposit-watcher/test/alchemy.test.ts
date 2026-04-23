import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isUsdcTransferTo,
  rawValueToMicros,
  verifyAlchemySignature,
  WebhookPayload,
  type ActivityEntryT,
} from '../src/alchemy.js';

const HOT = '0x0000000000000000000000000000000000000001';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function validEntry(over: Partial<ActivityEntryT> = {}): ActivityEntryT {
  return {
    hash: '0x' + 'a'.repeat(64),
    blockNum: '0x123',
    fromAddress: '0x' + 'b'.repeat(40),
    toAddress: HOT,
    asset: 'USDC',
    category: 'token',
    rawContract: {
      address: USDC,
      rawValue: '0xf4240', // 1_000_000 = 1 USDC
      decimals: 6,
    },
    ...over,
  };
}

describe('verifyAlchemySignature', () => {
  it('accepts a correctly HMAC-signed body', () => {
    const key = 'test-signing-key';
    const body = '{"hello":"world"}';
    const sig = crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
    expect(verifyAlchemySignature(body, sig, key)).toBe(true);
  });

  it('rejects a forged signature', () => {
    const key = 'test-signing-key';
    const body = '{"hello":"world"}';
    const forged = 'a'.repeat(64);
    expect(verifyAlchemySignature(body, forged, key)).toBe(false);
  });

  it('rejects when signing key mismatches', () => {
    const body = '{"hello":"world"}';
    const sig = crypto.createHmac('sha256', 'k1').update(body, 'utf8').digest('hex');
    expect(verifyAlchemySignature(body, sig, 'k2')).toBe(false);
  });

  it('rejects when signature header is missing', () => {
    expect(verifyAlchemySignature('{}', undefined, 'k')).toBe(false);
  });

  it('handles malformed hex without throwing', () => {
    expect(verifyAlchemySignature('{}', 'not-hex', 'k')).toBe(false);
  });
});

describe('rawValueToMicros', () => {
  it('parses USDC 6-decimal rawValue directly as micros (1 USDC = 1_000_000)', () => {
    expect(rawValueToMicros(validEntry())).toBe(1_000_000n);
  });

  it('handles large rawValue without precision loss', () => {
    const entry = validEntry({
      rawContract: { address: USDC, rawValue: '0x3b9aca00', decimals: 6 },
    }); // 1_000_000_000 = 1000 USDC
    expect(rawValueToMicros(entry)).toBe(1_000_000_000n);
  });

  it('falls back to normalized value when rawValue is absent', () => {
    const entry: ActivityEntryT = {
      ...validEntry(),
      rawContract: undefined,
      value: 2.5,
    };
    expect(rawValueToMicros(entry)).toBe(2_500_000n);
  });

  it('returns 0 when both rawValue and value are missing', () => {
    const entry: ActivityEntryT = {
      ...validEntry(),
      rawContract: undefined,
      value: undefined,
    };
    expect(rawValueToMicros(entry)).toBe(0n);
  });
});

describe('isUsdcTransferTo', () => {
  it('accepts a correct USDC Transfer to the hot wallet', () => {
    expect(isUsdcTransferTo(validEntry(), USDC, HOT)).toBe(true);
  });

  it('rejects when contract address differs (not USDC)', () => {
    const entry = validEntry({
      rawContract: { address: '0x' + '9'.repeat(40), rawValue: '0x1' },
    });
    expect(isUsdcTransferTo(entry, USDC, HOT)).toBe(false);
  });

  it('rejects when destination is not the hot wallet', () => {
    const entry = validEntry({ toAddress: '0x' + 'c'.repeat(40) });
    expect(isUsdcTransferTo(entry, USDC, HOT)).toBe(false);
  });

  it('accepts both token and erc20 category labels', () => {
    expect(isUsdcTransferTo(validEntry({ category: 'erc20' }), USDC, HOT)).toBe(true);
    expect(isUsdcTransferTo(validEntry({ category: 'token' }), USDC, HOT)).toBe(true);
  });

  it('rejects other categories', () => {
    expect(isUsdcTransferTo(validEntry({ category: 'external' }), USDC, HOT)).toBe(false);
    expect(isUsdcTransferTo(validEntry({ category: 'erc721' }), USDC, HOT)).toBe(false);
  });

  it('is case-insensitive on addresses', () => {
    const entry = validEntry({ toAddress: HOT.toUpperCase() });
    expect(isUsdcTransferTo(entry, USDC, HOT)).toBe(true);
  });
});

describe('WebhookPayload schema', () => {
  it('accepts a well-formed activity webhook', () => {
    const ok = WebhookPayload.safeParse({
      webhookId: 'wh_abc',
      id: 'evt_1',
      createdAt: '2026-04-23T12:00:00Z',
      type: 'ADDRESS_ACTIVITY',
      event: {
        network: 'BASE_MAINNET',
        activity: [validEntry()],
      },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a payload missing activity', () => {
    const bad = WebhookPayload.safeParse({
      webhookId: 'wh_abc',
      id: 'evt_1',
      createdAt: '2026-04-23T12:00:00Z',
      type: 'ADDRESS_ACTIVITY',
      event: { network: 'BASE_MAINNET' },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a malformed tx hash', () => {
    const bad = WebhookPayload.safeParse({
      webhookId: 'wh_abc',
      id: 'evt_1',
      createdAt: '2026-04-23T12:00:00Z',
      type: 'ADDRESS_ACTIVITY',
      event: {
        network: 'BASE_MAINNET',
        activity: [{ ...validEntry(), hash: 'not-a-hash' }],
      },
    });
    expect(bad.success).toBe(false);
  });
});
