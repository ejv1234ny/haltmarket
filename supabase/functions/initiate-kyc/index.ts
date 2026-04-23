// initiate-kyc — Phase 7 KYC callback receiver (skeleton).
//
// Accepts a POST from a KYC vendor's webhook after identity verification.
// Verifies the vendor signature, then forwards the decision to
// public.apply_kyc_decision so `user_profiles.kyc_status` flips to
// 'approved' / 'rejected' / 'pending'. The compliance gate in place_bet
// reads that column — flipping it is all the alpha rail needs.
//
// Vendor-agnostic skeleton: the vendor-specific field names are behind a
// small parser. Wire a real vendor by:
//   1. Setting KYC_VENDOR = 'persona' | 'sumsub' | 'stripe'
//   2. Setting KYC_WEBHOOK_SECRET = the vendor's signing secret
//   3. Filling in the parseVendorPayload branch for that vendor
//
// Until those are set this endpoint operates in 'stub' mode: accepts a
// plain JSON body { user_id, status, geo_country? } protected by a shared
// bearer token (KYC_STUB_BEARER) so ops can simulate vendor callbacks in
// dev without wiring a real integration. Stub mode is never enabled in
// prod — guard it behind KYC_VENDOR=stub.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Status = 'none' | 'pending' | 'approved' | 'rejected';

interface Decision {
  userId: string;
  status: Status;
  geoCountry?: string | null;
  provider: string;
  reference?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isUuid(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

function isStatus(s: unknown): s is Status {
  return s === 'none' || s === 'pending' || s === 'approved' || s === 'rejected';
}

// -----------------------------------------------------------------------------
// Persona vendor parser
//
// Webhook docs: https://docs.withpersona.com/docs/webhooks
//
// Signature header format: `Persona-Signature: t=<ts>,v1=<hex_hmac>`
// HMAC-SHA256 over "<ts>.<raw_body>" with KYC_WEBHOOK_SECRET.
// Reject timestamps older than 5 minutes to defeat replay.
//
// Payload: data.attributes.payload.data.attributes carries the inquiry's
// status + reference-id. Reference-id is what we set when creating the
// inquiry — populate it with the Supabase user_id.
// -----------------------------------------------------------------------------

const PERSONA_SIG_RE = /^t=(\d+),v1=([0-9a-f]+)$/i;
const MAX_WEBHOOK_SKEW_SECONDS = 300;

async function hmacHex(key: string, message: string): Promise<string> {
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

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyPersonaSignature(
  body: string,
  header: string,
  secret: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const match = PERSONA_SIG_RE.exec(header.trim());
  if (!match) return { ok: false, reason: 'signature header malformed' };
  const [, tsStr, signature] = match;
  const ts = Number.parseInt(tsStr ?? '', 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp invalid' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_WEBHOOK_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp skew too large' };
  }
  const expected = await hmacHex(secret, `${ts}.${body}`);
  if (!timingSafeEqualHex(expected, signature ?? '')) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

function mapPersonaInquiryStatus(s: unknown): Status | null {
  if (typeof s !== 'string') return null;
  const normalized = s.toLowerCase();
  // Persona inquiry statuses include: created, pending, expired, completed,
  // approved, declined, needs_review. Map per our 4-value vocabulary.
  if (normalized === 'approved') return 'approved';
  if (normalized === 'declined' || normalized === 'failed') return 'rejected';
  if (normalized === 'completed' || normalized === 'needs_review') return 'pending';
  if (normalized === 'pending' || normalized === 'created') return 'pending';
  if (normalized === 'expired') return 'rejected';
  return null;
}

function parsePersonaPayload(raw: unknown):
  | { ok: true; value: Decision }
  | { ok: false; message: string } {
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
    return {
      ok: false,
      message: 'reference-id must be the Supabase user_id UUID',
    };
  }

  const status = mapPersonaInquiryStatus(attrs.status);
  if (!status) {
    return { ok: false, message: `unsupported inquiry status: ${String(attrs.status)}` };
  }

  // Country hints live under attributes.countries or attributes.fields.country.
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
      reference: typeof inner.id === 'string' ? (inner.id as string) : undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// Sumsub vendor parser
//
// Webhook docs: https://developers.sumsub.com/api-reference/#section/Webhooks
//
// Signature: HMAC-SHA256(rawBody, secret) in hex via `X-Payload-Digest`.
// Algorithm carried on `X-Payload-Digest-Alg` (expect HMAC_SHA256_HEX).
// Payload carries externalUserId — populate this with the Supabase user_id
// when creating the applicant via Sumsub's API.
//
// Status mapping (reviewAnswer): GREEN→approved, RED→rejected,
// YELLOW→pending (the user is asked to resubmit).
// -----------------------------------------------------------------------------

function mapSumsubAnswer(answer: unknown): Status | null {
  if (typeof answer !== 'string') return null;
  const normalized = answer.toUpperCase();
  if (normalized === 'GREEN') return 'approved';
  if (normalized === 'RED') return 'rejected';
  if (normalized === 'YELLOW') return 'pending';
  return null;
}

function parseSumsubPayload(raw: unknown):
  | { ok: true; value: Decision }
  | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: 'body not an object' };
  }
  const r = raw as Record<string, unknown>;

  const externalUserId = r.externalUserId;
  if (!isUuid(externalUserId)) {
    return {
      ok: false,
      message: 'externalUserId must be the Supabase user_id UUID',
    };
  }

  // Non-terminal webhook types (applicantCreated, applicantPending, etc.)
  // are pushed through as 'pending'. Only applicantReviewed carries the
  // reviewResult that triggers approve/reject.
  const type = typeof r.type === 'string' ? r.type : '';
  let status: Status | null = null;
  if (type === 'applicantReviewed') {
    const rr = r.reviewResult as Record<string, unknown> | undefined;
    status = mapSumsubAnswer(rr?.reviewAnswer);
    if (!status) {
      return {
        ok: false,
        message: `unknown reviewAnswer: ${String(rr?.reviewAnswer)}`,
      };
    }
  } else if (type === 'applicantPending' || type === 'applicantCreated') {
    status = 'pending';
  } else {
    // Non-actionable event types (applicantWorkflowCompleted, etc.). Ack
    // with a no-op so Sumsub doesn't retry.
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
// Stripe Identity vendor parser
//
// Webhook docs: https://stripe.com/docs/webhooks/signatures
//
// Signature: `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>...]`. Verify via
// HMAC-SHA256 over "<ts>.<raw_body>" with STRIPE_WEBHOOK_SECRET. Reject
// older-than-5-min timestamps.
//
// The VerificationSession id/client_reference_id carries the user_id; set
// `metadata.user_id` when creating the session via the Stripe API so this
// parser can find it.
// -----------------------------------------------------------------------------

async function verifyStripeSignature(
  body: string,
  header: string,
  secret: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parts = header.split(',').map((p) => p.trim());
  const tsPart = parts.find((p) => p.startsWith('t='));
  const v1Signatures = parts
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!tsPart || v1Signatures.length === 0) {
    return { ok: false, reason: 'signature header malformed' };
  }
  const ts = Number.parseInt(tsPart.slice(2), 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp invalid' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_WEBHOOK_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp skew too large' };
  }
  const expected = await hmacHex(secret, `${ts}.${body}`);
  const match = v1Signatures.some((sig) => timingSafeEqualHex(expected, sig));
  if (!match) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

function parseStripeIdentityPayload(raw: unknown):
  | { ok: true; value: Decision }
  | { ok: false; message: string } {
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

  // Stripe Identity events we care about:
  //   identity.verification_session.verified  → approved
  //   identity.verification_session.requires_input → pending (user needs to
  //       resubmit; not a hard reject).
  //   identity.verification_session.canceled  → rejected (user abandoned)
  //   identity.verification_session.processing → pending
  //   identity.verification_session.created   → pending
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
      geoCountry: null, // Stripe Identity doesn't return country on the session object
      provider: 'stripe',
      reference: typeof obj.id === 'string' ? (obj.id as string) : undefined,
    },
  };
}

function parseStubPayload(raw: unknown):
  | { ok: true; value: Decision }
  | { ok: false; message: string } {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Deno?.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (globalThis as any).Deno?.env;
  const supabaseUrl = env?.get('SUPABASE_URL');
  const serviceKey = env?.get('SUPABASE_SERVICE_ROLE_KEY');
  const vendor = env?.get('KYC_VENDOR') ?? 'stub';
  const stubBearer = env?.get('KYC_STUB_BEARER') ?? '';

  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: 'misconfigured' });
  }

  let parsed: { ok: true; value: Decision } | { ok: false; message: string };

  if (vendor === 'stub') {
    // Stub mode: require a shared bearer token. Intended for dev + tests.
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : '';
    if (!stubBearer || token !== stubBearer) {
      return json(401, { error: 'unauthorized' });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    parsed = parseStubPayload(body);
  } else if (vendor === 'persona') {
    const secret = env?.get('KYC_WEBHOOK_SECRET') ?? '';
    if (!secret) return json(500, { error: 'webhook_secret_missing' });
    const rawBody = await req.text();
    const sigHeader = req.headers.get('persona-signature') ?? '';
    const verify = await verifyPersonaSignature(rawBody, sigHeader, secret);
    if (!verify.ok) return json(401, { error: 'bad_signature', message: verify.reason });

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    parsed = parsePersonaPayload(body);
  } else if (vendor === 'sumsub') {
    const secret = env?.get('KYC_WEBHOOK_SECRET') ?? '';
    if (!secret) return json(500, { error: 'webhook_secret_missing' });
    const rawBody = await req.text();
    const digest = req.headers.get('x-payload-digest') ?? '';
    const alg = (req.headers.get('x-payload-digest-alg') ?? 'HMAC_SHA256_HEX').toUpperCase();
    if (alg !== 'HMAC_SHA256_HEX') {
      return json(401, { error: 'bad_signature', message: `unsupported alg ${alg}` });
    }
    const expected = await hmacHex(secret, rawBody);
    if (!timingSafeEqualHex(expected, digest)) {
      return json(401, { error: 'bad_signature', message: 'digest mismatch' });
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    parsed = parseSumsubPayload(body);
  } else if (vendor === 'stripe') {
    const secret = env?.get('KYC_WEBHOOK_SECRET') ?? '';
    if (!secret) return json(500, { error: 'webhook_secret_missing' });
    const rawBody = await req.text();
    const sigHeader = req.headers.get('stripe-signature') ?? '';
    const verify = await verifyStripeSignature(rawBody, sigHeader, secret);
    if (!verify.ok) return json(401, { error: 'bad_signature', message: verify.reason });

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    parsed = parseStripeIdentityPayload(body);
  } else {
    return json(501, {
      error: 'vendor_not_implemented',
      message: `KYC_VENDOR=${vendor} parser not wired yet; see initiate-kyc/index.ts`,
    });
  }

  if (!parsed.ok) return json(400, { error: 'invalid_input', message: parsed.message });
  const d = parsed.value;

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { error } = await db.rpc('apply_kyc_decision', {
    p_user_id: d.userId,
    p_status: d.status,
    p_geo_country: d.geoCountry ?? null,
    p_provider: d.provider,
    p_reference: d.reference ?? null,
  });
  if (error) {
    console.error('apply_kyc_decision failed', error);
    return json(500, { error: 'rpc_failed', message: error.message });
  }

  return json(200, { applied: true, user_id: d.userId, status: d.status });
});
