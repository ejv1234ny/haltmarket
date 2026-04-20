// Request-shape validation for place-bet. Runs before the DB RPC so we
// produce clean 400s without round-tripping. Mirrored (and re-checked)
// inside the `place_bet` plpgsql function — defense in depth.

export interface PlaceBetRequest {
  market_id: string;
  predicted_price: number;
  stake_micro: string; // bigint-as-string on the wire for precision
  idempotency_key: string;
}

export interface ValidPlaceBetRequest {
  marketId: string;
  predictedPrice: number;
  stakeMicro: bigint;
  idempotencyKey: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidationError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'invalid_price_precision'; message: string };

export function parsePlaceBetRequest(
  raw: unknown,
): { ok: true; value: ValidPlaceBetRequest } | { ok: false; err: ValidationError } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, err: { kind: 'invalid_input', message: 'body must be a JSON object' } };
  }
  const r = raw as Record<string, unknown>;

  const marketId = r['market_id'];
  if (typeof marketId !== 'string' || !UUID_RE.test(marketId)) {
    return { ok: false, err: { kind: 'invalid_input', message: 'market_id must be a UUID' } };
  }

  const predictedPrice = r['predicted_price'];
  if (typeof predictedPrice !== 'number'
      || !Number.isFinite(predictedPrice)
      || predictedPrice <= 0) {
    return { ok: false, err: { kind: 'invalid_input', message: 'predicted_price must be a positive number' } };
  }
  // ADR-0002: numeric(12,4). Reject more than 4 decimal places on the wire
  // so the client can't accidentally round a bet input to a different bin.
  const priceStr = String(predictedPrice);
  if (priceStr.includes('e') || priceStr.includes('E')) {
    return {
      ok: false,
      err: {
        kind: 'invalid_price_precision',
        message: 'predicted_price must not use scientific notation',
      },
    };
  }
  const dot = priceStr.indexOf('.');
  if (dot >= 0 && priceStr.length - dot - 1 > 4) {
    return {
      ok: false,
      err: {
        kind: 'invalid_price_precision',
        message: 'predicted_price must have at most 4 decimal places',
      },
    };
  }

  const stakeRaw = r['stake_micro'];
  let stakeMicro: bigint;
  try {
    if (typeof stakeRaw === 'string') {
      if (!/^\d+$/.test(stakeRaw)) throw new Error('must be digits');
      stakeMicro = BigInt(stakeRaw);
    } else if (typeof stakeRaw === 'number' && Number.isSafeInteger(stakeRaw)) {
      stakeMicro = BigInt(stakeRaw);
    } else {
      throw new Error('unsupported type');
    }
  } catch {
    return { ok: false, err: { kind: 'invalid_input', message: 'stake_micro must be a bigint string or safe integer' } };
  }
  if (stakeMicro <= 0n) {
    return { ok: false, err: { kind: 'invalid_input', message: 'stake_micro must be positive' } };
  }

  const idempotencyKey = r['idempotency_key'];
  if (typeof idempotencyKey !== 'string' || !UUID_RE.test(idempotencyKey)) {
    return { ok: false, err: { kind: 'invalid_input', message: 'idempotency_key must be a UUID' } };
  }

  return {
    ok: true,
    value: {
      marketId,
      predictedPrice,
      stakeMicro,
      idempotencyKey,
    },
  };
}
