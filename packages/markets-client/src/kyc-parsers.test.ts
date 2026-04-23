// Unit tests for supabase/functions/_shared/kyc-parsers.ts.
//
// Lives inside markets-client to piggyback on the existing vitest config;
// imports via relative path. The parser module has no esm.sh or Deno-only
// imports, so it loads cleanly in Node 20+ vitest.

import { describe, expect, it } from 'vitest';
import {
  hmacHex,
  isUuid,
  mapPersonaInquiryStatus,
  mapSumsubAnswer,
  parsePersonaPayload,
  parseStripeIdentityPayload,
  parseStubPayload,
  parseSumsubPayload,
  timingSafeEqualHex,
  verifyPersonaSignature,
  verifyStripeSignature,
  verifySumsubSignature,
} from '../../../supabase/functions/_shared/kyc-parsers.ts';

const USER_UUID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'test-secret';

describe('hmacHex + timingSafeEqualHex', () => {
  it('produces a 64-char lowercase hex digest', async () => {
    const h = await hmacHex('k', 'hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for same key+message', async () => {
    const a = await hmacHex('k', 'payload');
    const b = await hmacHex('k', 'payload');
    expect(a).toBe(b);
  });

  it('differs when the secret differs', async () => {
    const a = await hmacHex('k1', 'payload');
    const b = await hmacHex('k2', 'payload');
    expect(a).not.toBe(b);
  });

  it('timingSafeEqualHex returns true on identical strings', () => {
    expect(timingSafeEqualHex('abc', 'abc')).toBe(true);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
  });

  it('returns false for same-length but different hex', () => {
    expect(timingSafeEqualHex('deadbeef', 'feedbeef')).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts canonical UUID', () => {
    expect(isUuid(USER_UUID)).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe('verifyPersonaSignature', () => {
  async function sigFor(body: string, ts: number): Promise<string> {
    const hex = await hmacHex(SECRET, `${ts}.${body}`);
    return `t=${ts},v1=${hex}`;
  }

  it('accepts a freshly signed body', async () => {
    const body = '{"hello":"world"}';
    const ts = 1_700_000_000;
    const header = await sigFor(body, ts);
    const res = await verifyPersonaSignature(body, header, SECRET, ts);
    expect(res.ok).toBe(true);
  });

  it('rejects a stale timestamp (> 5 min skew)', async () => {
    const body = '{}';
    const tsOld = 1_700_000_000;
    const header = await sigFor(body, tsOld);
    const res = await verifyPersonaSignature(body, header, SECRET, tsOld + 400);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('skew');
  });

  it('rejects a wrong signature', async () => {
    const body = '{}';
    const ts = 1_700_000_000;
    const header = `t=${ts},v1=${'a'.repeat(64)}`;
    const res = await verifyPersonaSignature(body, header, SECRET, ts);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('mismatch');
  });

  it('rejects a malformed header', async () => {
    const res = await verifyPersonaSignature('body', 'not-a-header', SECRET, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('malformed');
  });

  it('rejects non-numeric timestamp', async () => {
    const res = await verifyPersonaSignature('body', 't=abc,v1=deadbeef', SECRET, 1);
    expect(res.ok).toBe(false);
  });
});

describe('mapPersonaInquiryStatus', () => {
  it('maps approved → approved', () => {
    expect(mapPersonaInquiryStatus('approved')).toBe('approved');
  });
  it('maps declined and failed → rejected', () => {
    expect(mapPersonaInquiryStatus('declined')).toBe('rejected');
    expect(mapPersonaInquiryStatus('failed')).toBe('rejected');
    expect(mapPersonaInquiryStatus('expired')).toBe('rejected');
  });
  it('maps completed/needs_review/pending/created → pending', () => {
    expect(mapPersonaInquiryStatus('completed')).toBe('pending');
    expect(mapPersonaInquiryStatus('needs_review')).toBe('pending');
    expect(mapPersonaInquiryStatus('pending')).toBe('pending');
    expect(mapPersonaInquiryStatus('created')).toBe('pending');
  });
  it('is case-insensitive', () => {
    expect(mapPersonaInquiryStatus('APPROVED')).toBe('approved');
  });
  it('returns null for unknown', () => {
    expect(mapPersonaInquiryStatus('weird')).toBeNull();
    expect(mapPersonaInquiryStatus(123)).toBeNull();
  });
});

describe('parsePersonaPayload', () => {
  function makePayload(status: string, refId = USER_UUID): unknown {
    return {
      data: {
        type: 'event',
        attributes: {
          name: 'inquiry.completed',
          payload: {
            data: {
              id: 'inq_123',
              type: 'inquiry',
              attributes: {
                status,
                'reference-id': refId,
                country_code: 'us',
              },
            },
          },
        },
      },
    };
  }

  it('returns a Decision for a well-formed approved inquiry', () => {
    const res = parsePersonaPayload(makePayload('approved'));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.userId).toBe(USER_UUID);
      expect(res.value.status).toBe('approved');
      expect(res.value.provider).toBe('persona');
      expect(res.value.geoCountry).toBe('US');
      expect(res.value.reference).toBe('inq_123');
    }
  });

  it('rejects non-UUID reference-id', () => {
    const res = parsePersonaPayload(makePayload('approved', 'not-a-uuid'));
    expect(res.ok).toBe(false);
  });

  it('rejects unsupported inquiry status', () => {
    const res = parsePersonaPayload(makePayload('abandoned'));
    expect(res.ok).toBe(false);
  });

  it('rejects missing nested attributes', () => {
    const res = parsePersonaPayload({ data: { attributes: {} } });
    expect(res.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(parsePersonaPayload(null).ok).toBe(false);
    expect(parsePersonaPayload('str').ok).toBe(false);
  });
});

describe('verifySumsubSignature', () => {
  it('accepts matching digest with HMAC_SHA256_HEX alg', async () => {
    const body = 'payload';
    const digest = await hmacHex(SECRET, body);
    const res = await verifySumsubSignature(body, digest, 'HMAC_SHA256_HEX', SECRET);
    expect(res.ok).toBe(true);
  });

  it('is case-insensitive on alg', async () => {
    const body = 'payload';
    const digest = await hmacHex(SECRET, body);
    const res = await verifySumsubSignature(body, digest, 'hmac_sha256_hex', SECRET);
    expect(res.ok).toBe(true);
  });

  it('rejects other algs', async () => {
    const res = await verifySumsubSignature('p', 'deadbeef', 'SHA512', SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('unsupported alg');
  });

  it('rejects wrong digest', async () => {
    const res = await verifySumsubSignature('p', 'a'.repeat(64), 'HMAC_SHA256_HEX', SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('mismatch');
  });
});

describe('mapSumsubAnswer', () => {
  it('GREEN → approved, RED → rejected, YELLOW → pending', () => {
    expect(mapSumsubAnswer('GREEN')).toBe('approved');
    expect(mapSumsubAnswer('RED')).toBe('rejected');
    expect(mapSumsubAnswer('YELLOW')).toBe('pending');
  });
  it('is case-insensitive', () => {
    expect(mapSumsubAnswer('green')).toBe('approved');
  });
  it('returns null on unknown', () => {
    expect(mapSumsubAnswer('BLUE')).toBeNull();
  });
});

describe('parseSumsubPayload', () => {
  it('approved GREEN review → approved', () => {
    const res = parseSumsubPayload({
      externalUserId: USER_UUID,
      type: 'applicantReviewed',
      applicantId: 'app_abc',
      reviewResult: { reviewAnswer: 'GREEN' },
      info: { country: 'USA' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('approved');
      expect(res.value.reference).toBe('app_abc');
      expect(res.value.geoCountry).toBe('US');
    }
  });

  it('pending applicantCreated → pending', () => {
    const res = parseSumsubPayload({
      externalUserId: USER_UUID,
      type: 'applicantCreated',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe('pending');
  });

  it('rejects unmapped event types', () => {
    const res = parseSumsubPayload({
      externalUserId: USER_UUID,
      type: 'applicantDeleted',
    });
    expect(res.ok).toBe(false);
  });

  it('rejects missing externalUserId', () => {
    const res = parseSumsubPayload({ type: 'applicantReviewed' });
    expect(res.ok).toBe(false);
  });
});

describe('verifyStripeSignature', () => {
  async function sigFor(body: string, ts: number): Promise<string> {
    const hex = await hmacHex(SECRET, `${ts}.${body}`);
    return `t=${ts},v1=${hex}`;
  }

  it('accepts a single-signature header', async () => {
    const body = '{"evt":"ok"}';
    const ts = 1_700_000_000;
    const header = await sigFor(body, ts);
    const res = await verifyStripeSignature(body, header, SECRET, ts);
    expect(res.ok).toBe(true);
  });

  it('accepts when any v1 in a multi-sig header matches', async () => {
    const body = 'abc';
    const ts = 1_700_000_000;
    const good = await hmacHex(SECRET, `${ts}.${body}`);
    const header = `t=${ts},v1=${'0'.repeat(64)},v1=${good}`;
    const res = await verifyStripeSignature(body, header, SECRET, ts);
    expect(res.ok).toBe(true);
  });

  it('rejects if no v1 matches', async () => {
    const res = await verifyStripeSignature(
      'body',
      `t=1,v1=${'0'.repeat(64)}`,
      SECRET,
      1,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects stale timestamp', async () => {
    const body = 'x';
    const ts = 1_700_000_000;
    const header = await sigFor(body, ts);
    const res = await verifyStripeSignature(body, header, SECRET, ts + 600);
    expect(res.ok).toBe(false);
  });

  it('rejects headers missing t= or v1=', async () => {
    const r1 = await verifyStripeSignature('b', 'v1=abc', SECRET, 1);
    expect(r1.ok).toBe(false);
    const r2 = await verifyStripeSignature('b', 't=1', SECRET, 1);
    expect(r2.ok).toBe(false);
  });
});

describe('parseStripeIdentityPayload', () => {
  function makeEvent(type: string, userId = USER_UUID): unknown {
    return {
      type,
      data: {
        object: {
          id: 'vs_abc',
          metadata: { user_id: userId },
        },
      },
    };
  }

  it('verified → approved', () => {
    const res = parseStripeIdentityPayload(
      makeEvent('identity.verification_session.verified'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe('approved');
      expect(res.value.reference).toBe('vs_abc');
    }
  });

  it('requires_input → pending', () => {
    const res = parseStripeIdentityPayload(
      makeEvent('identity.verification_session.requires_input'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe('pending');
  });

  it('canceled → rejected', () => {
    const res = parseStripeIdentityPayload(
      makeEvent('identity.verification_session.canceled'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe('rejected');
  });

  it('falls back to client_reference_id when metadata.user_id missing', () => {
    const res = parseStripeIdentityPayload({
      type: 'identity.verification_session.verified',
      data: {
        object: {
          id: 'vs_abc',
          client_reference_id: USER_UUID,
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.userId).toBe(USER_UUID);
  });

  it('rejects events we do not model', () => {
    const res = parseStripeIdentityPayload(makeEvent('identity.something_else'));
    expect(res.ok).toBe(false);
  });

  it('rejects missing user id linkage', () => {
    const res = parseStripeIdentityPayload({
      type: 'identity.verification_session.verified',
      data: { object: { id: 'vs_abc' } },
    });
    expect(res.ok).toBe(false);
  });
});

describe('parseStubPayload', () => {
  it('accepts a minimal valid body', () => {
    const res = parseStubPayload({ user_id: USER_UUID, status: 'approved' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.provider).toBe('stub');
      expect(res.value.status).toBe('approved');
    }
  });

  it('uppercases and accepts geo_country', () => {
    const res = parseStubPayload({
      user_id: USER_UUID,
      status: 'approved',
      geo_country: 'us',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.geoCountry).toBe('US');
  });

  it('rejects bad status', () => {
    const res = parseStubPayload({ user_id: USER_UUID, status: 'weird' });
    expect(res.ok).toBe(false);
  });

  it('rejects non-uuid user_id', () => {
    const res = parseStubPayload({ user_id: 'abc', status: 'approved' });
    expect(res.ok).toBe(false);
  });
});
