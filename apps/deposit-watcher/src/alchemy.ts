import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Alchemy Notify address-activity webhook payload shape.
 * See https://docs.alchemy.com/reference/notify-api-quickstart
 *
 * We subscribe to one address-activity webhook targeting the Safe hot wallet.
 * Alchemy filters by address + asset (USDC) and pushes an "event" object
 * containing one or more activity entries.
 */
export const ActivityEntry = z.object({
  // External-transaction view
  hash:         z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  blockNum:     z.string(),                                 // hex-encoded
  fromAddress:  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  toAddress:    z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  // For token transfers, Alchemy normalizes value to the token's decimals.
  asset:        z.string(),                                 // e.g., "USDC"
  category:     z.enum(['external', 'internal', 'token', 'erc20', 'erc721', 'erc1155']),
  value:        z.number().optional(),                      // human-readable, may lose precision
  rawContract:  z.object({
    // Raw on-chain amount as hex (most precise). Always present for token activity.
    rawValue: z.string().optional(),
    address:  z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
    decimals: z.union([z.number(), z.string()]).optional(),
  }).optional(),
});

export const WebhookPayload = z.object({
  webhookId:   z.string(),
  id:          z.string(),
  createdAt:   z.string(),
  type:        z.string(),
  event: z.object({
    network:  z.string(),
    activity: z.array(ActivityEntry),
  }),
});

export type WebhookPayloadT = z.infer<typeof WebhookPayload>;
export type ActivityEntryT  = z.infer<typeof ActivityEntry>;

/**
 * Verify Alchemy signature header against the raw request body.
 *
 * Alchemy signs webhooks with HMAC-SHA256 using the signing key from the
 * webhook settings. Header name: `X-Alchemy-Signature`.
 */
export function verifyAlchemySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  signingKey: string
): boolean {
  if (!signatureHeader) return false;
  const mac = crypto.createHmac('sha256', signingKey);
  mac.update(rawBody, 'utf8');
  const expected = mac.digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signatureHeader, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Parse rawValue hex into a BigInt of USDC micros (6 decimals on Base).
 * If decimals is 6 (USDC default) and rawValue is already in on-chain units,
 * micros = rawValue (1 USDC = 1_000_000 rawUnits = 1_000_000 micros).
 */
export function rawValueToMicros(entry: ActivityEntryT): bigint {
  const raw = entry.rawContract?.rawValue;
  if (raw && raw.startsWith('0x')) {
    return BigInt(raw);
  }
  // Fallback: use normalized `value` but this loses precision for fractional USDC.
  if (typeof entry.value === 'number') {
    return BigInt(Math.round(entry.value * 1_000_000));
  }
  return 0n;
}

export function isUsdcTransferTo(
  entry: ActivityEntryT,
  usdcAddress: string,
  hotWalletAddress: string
): boolean {
  const contractOk  = entry.rawContract?.address?.toLowerCase() === usdcAddress.toLowerCase();
  const toOk        = entry.toAddress.toLowerCase() === hotWalletAddress.toLowerCase();
  const categoryOk  = entry.category === 'token' || entry.category === 'erc20';
  return Boolean(contractOk && toOk && categoryOk);
}
