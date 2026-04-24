// initiate-kyc — Phase 7 KYC callback receiver.
//
// Accepts a POST from a KYC vendor's webhook after identity verification.
// Verifies the vendor signature (per vendor), then forwards the decision
// to public.apply_kyc_decision so `user_profiles.kyc_status` flips to
// 'approved' / 'rejected' / 'pending'. The compliance gate in place_bet
// reads that column — flipping it is all the alpha rail needs.
//
// Pure parser + signature helpers live in `../_shared/kyc-parsers.ts` so
// vitest can unit-test them from Node without Deno runtime.
//
// Vendors wired: stub (dev-only bearer auth), persona, sumsub, stripe.
// Select via KYC_VENDOR env var. All share KYC_WEBHOOK_SECRET for the
// signing-secret input.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  hmacHex,
  parsePersonaPayload,
  parseStripeIdentityPayload,
  parseStubPayload,
  parseSumsubPayload,
  timingSafeEqualHex,
  verifyPersonaSignature,
  verifyStripeSignature,
  verifySumsubSignature,
  type Decision,
  type ParseResult,
} from '../_shared/kyc-parsers.ts';

void hmacHex;
void timingSafeEqualHex;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

  let parsed: ParseResult;

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
    const alg = req.headers.get('x-payload-digest-alg') ?? 'HMAC_SHA256_HEX';
    const verify = await verifySumsubSignature(rawBody, digest, alg, secret);
    if (!verify.ok) return json(401, { error: 'bad_signature', message: verify.reason });

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
  const d: Decision = parsed.value;

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
