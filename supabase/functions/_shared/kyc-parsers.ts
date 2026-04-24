// Shared KYC payload + signature helpers.
//
// Pure functions — no Supabase client, no Deno globals, no esm.sh imports —
// so they run identically in Deno (edge functions) and in Node (vitest).
// Uses the Web Crypto API (globalThis.crypto.subtle), which Node 20+ and
// Deno both implement natively.

export type Status = 'none' | 'pending' | 'approved' | 'rejected';

export interface Decision {
  userId: string;
  status: Status;
  geoCountry?: string | null;
  provider: 'stub' | 'persona' | 'sumsub' | 'stripe';
  reference?: string;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_WEBHOOK_SKEW_SECONDS = 300;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function isStatus(s: unknown): s is Status {
  return s === 'none' || s === 'pending' || s === 'approved' || s === 'rejected';
}

// -----------------------------------------------------------------------------
// HMAC primitives
// -----------------------------------------------------------------------------

export async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// -----------------------------------------------------------------------------
// Persona
//
// Header: `Persona-Signature: t=<ts>,v1=<hex>`
// HMAC-SHA256 over `<ts>.<raw_body>` with KYC_WEBHOOK_SECRET.
// -----------------------------------------------------------------------------

const PERSONA_SIG_RE = /^t=(\d+),v1=([0-9a-f]+)$/i;

export interface SigResult {
  ok: boolean;
  reason?: string;
}

export async function verifyPersonaSignature(
  body: string,
  header: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<SigResult> {
  const match = PERSONA_SIG_RE.exec(header.trim());
  if (!match) return { ok: false, reason: 'signature header malformed' };
  const [, tsStr, signature] = match;
  const ts = Number.parseInt(tsStr ?? '', 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp invalid' };
  if (Math.abs(nowSec - ts) > MAX_WEBHOOK_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp skew too large' };
  }
  const expected = await hmacHex(secret, `${ts}.${body}`);
  if (!timingSafeEqualHex(expected, signature ?? '')) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

export function mapPersonaInquiryStatus(s: unknown): Status | null {
  if (typeof s !== 'string') return null;
  const normalized = s.toLowerCase();
  if (normalized === 'approved') return 'approved';
  if (normalized === 'declined' || normalized === 'failed') return 'rejected';
  if (normalized === 'completed' || normalized === 'needs_review') return 'pending';
  if (normalized === 'pending' || normalized === 'created') return 'pending';
  if (normalized === 'expired') return 'rejected';
  return null;
}

export type ParseResult =
  | { ok: true; value: Decision }
  | { ok: false; message: string };

export function parsePersonaPayload(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'body not an object' };
  }
  const root = raw as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | undefined;
  const outer = data?.attributes as Record<string, unknown> | undefined;
  const payload = outer?.payload as Record<string, unknown> | undefined;
  const inner = payload?.data as Record<string, unknown> | undefined;
  const attrs = inner?.attributes as Record<string, unknown> | undefined;
  if (!attrs) {
    return { ok: false, message: 'missing data.attributes.payload.data.attributes' };
  }

  const referenceId = attrs['reference-id'] ?? attrs['referenceId'];
  if (!isUuid(referenceId)) {
    return { ok: false, message: 'reference-id must be the Supabase user_id UUID' };
  }

  const status = mapPersonaInquiryStatus(attrs.status);
  if (!status) {
    return { ok: false, message: `unsupported inquiry status: ${String(attrs.status)}` };
  }

  const geoRaw =
    (attrs.country_code as string | undefined) ??
    (attrs['country-code'] as string | undefined);
  const geoCountry =
    typeof geoRaw === 'string' && /^[a-zA-Z]{2}$/.test(geoRaw)
      ? geoRaw.toUpperCase()
      : undefined;

  return {
    ok: true,
    value: {
      userId: referenceId as string,
      status,
      geoCountry: geoCountry ?? null,
      provider: 'persona',
      reference: typeof inner?.id === 'string' ? (inner.id as string) : undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// Sumsub
//
// Header: `X-Payload-Digest: <hex>` with `X-Payload-Digest-Alg: HMAC_SHA256_HEX`.
// Digest is HMAC-SHA256 over the raw body.
// -----------------------------------------------------------------------------

export async function verifySumsubSignature(
  body: string,
  digest: string,
  alg: string,
  secret: string,
): Promise<SigResult> {
  if (alg.toUpperCase() !== 'HMAC_SHA256_HEX') {
    return { ok: false, reason: `unsupported alg ${alg}` };
  }
  const expected = await hmacHex(secret, body);
  if (!timingSafeEqualHex(expected, digest)) {
    return { ok: false, reason: 'digest mismatch' };
  }
  return { ok: true };
}

export function mapSumsubAnswer(answer: unknown): Status | null {
  if (typeof answer !== 'string') return null;
  const normalized = answer.toUpperCase();
  if (normalized === 'GREEN') return 'approved';
  if (normalized === 'RED') return 'rejected';
  if (normalized === 'YELLOW') return 'pending';
  return null;
}

export function parseSumsubPayload(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'body not an object' };
  }
  const r = raw as Record<string, unknown>;

  const externalUserId = r.externalUserId;
  if (!isUuid(externalUserId)) {
    return { ok: false, message: 'externalUserId must be the Supabase user_id UUID' };
  }

  const type = typeof r.type === 'string' ? r.type : '';
  let status: Status | null = null;
  if (type === 'applicantReviewed') {
    const rr = r.reviewResult as Record<string, unknown> | undefined;
    status = mapSumsubAnswer(rr?.reviewAnswer);
    if (!status) {
      return { ok: false, message: `unknown reviewAnswer: ${String(rr?.reviewAnswer)}` };
    }
  } else if (type === 'applicantPending' || type === 'applicantCreated') {
    status = 'pending';
  } else {
    return { ok: false, message: `ignored event type: ${type}` };
  }

  const infoCountry = (r.info as Record<string, unknown> | undefined)?.country;
  const geoCountry =
    typeof infoCountry === 'string' && /^[a-zA-Z]{2,3}$/.test(infoCountry)
      ? infoCountry.toUpperCase().slice(0, 2)
      : undefined;

  return {
    ok: true,
    value: {
      userId: externalUserId as string,
      status,
      geoCountry: geoCountry ?? null,
      provider: 'sumsub',
      reference: typeof r.applicantId === 'string' ? (r.applicantId as string) : undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// Stripe Identity
//
// Header: `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>...]`.
// HMAC-SHA256 over `<ts>.<raw_body>` with whsec_... secret.
// -----------------------------------------------------------------------------

export async function verifyStripeSignature(
  body: string,
  header: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<SigResult> {
  const parts = header.split(',').map((p) => p.trim());
  const tsPart = parts.find((p) => p.startsWith('t='));
  const v1Signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!tsPart || v1Signatures.length === 0) {
    return { ok: false, reason: 'signature header malformed' };
  }
  const ts = Number.parseInt(tsPart.slice(2), 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp invalid' };
  if (Math.abs(nowSec - ts) > MAX_WEBHOOK_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp skew too large' };
  }
  const expected = await hmacHex(secret, `${ts}.${body}`);
  const match = v1Signatures.some((sig) => timingSafeEqualHex(expected, sig));
  if (!match) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

export function parseStripeIdentityPayload(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'body not an object' };
  }
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : '';
  const obj = (r.data as Record<string, unknown> | undefined)
    ?.object as Record<string, unknown> | undefined;
  if (!obj) return { ok: false, message: 'missing data.object' };

  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const userId = metadata?.user_id ?? obj.client_reference_id;
  if (!isUuid(userId)) {
    return {
      ok: false,
      message: 'metadata.user_id (or client_reference_id) must be the Supabase user UUID',
    };
  }

  let status: Status;
  if (type === 'identity.verification_session.verified') status = 'approved';
  else if (
    type === 'identity.verification_session.requires_input' ||
    type === 'identity.verification_session.processing' ||
    type === 'identity.verification_session.created'
  ) {
    status = 'pending';
  } else if (type === 'identity.verification_session.canceled') {
    status = 'rejected';
  } else {
    return { ok: false, message: `ignored event type: ${type}` };
  }

  return {
    ok: true,
    value: {
      userId: userId as string,
      status,
      geoCountry: null,
      provider: 'stripe',
      reference: typeof obj.id === 'string' ? (obj.id as string) : undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// Stub (local dev + tests)
// -----------------------------------------------------------------------------

export function parseStubPayload(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'body must be JSON object' };
  }
  const r = raw as Record<string, unknown>;
  const userId = r.user_id;
  const status = r.status;
  if (!isUuid(userId)) return { ok: false, message: 'user_id must be UUID' };
  if (!isStatus(status)) {
    return { ok: false, message: 'status must be none|pending|approved|rejected' };
  }
  const geoRaw = r.geo_country;
  const geoCountry =
    typeof geoRaw === 'string' && /^[a-zA-Z]{2}$/.test(geoRaw)
      ? geoRaw.toUpperCase()
      : undefined;
  return {
    ok: true,
    value: {
      userId,
      status,
      geoCountry: geoCountry ?? null,
      provider: 'stub',
      reference: typeof r.reference === 'string' ? r.reference : undefined,
    },
  };
}
