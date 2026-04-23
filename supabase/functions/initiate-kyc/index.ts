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
  } else {
    // Real-vendor branch: implement per KYC_VENDOR.
    //   * Persona: verify HMAC of raw body with KYC_WEBHOOK_SECRET via the
    //     `Persona-Signature` header, parse payload.data.attributes.status.
    //   * Sumsub: verify `X-Payload-Digest` HMAC, parse applicantId → user_id
    //     via your own applicant-id map, reviewStatus → status.
    //   * Stripe Identity: stripe.webhooks.constructEvent on raw body, then
    //     read `identity.verification_session.verified` or `.requires_input`.
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
