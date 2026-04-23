// Integration tests for the admin-gated RPCs added in migrations 0010,
// 0011, 0013, 0016. Each test verifies:
//   1. A non-admin caller is rejected (42501).
//   2. An admin caller succeeds and the target state changes.
//
// We simulate "non-admin caller" by SET LOCAL role authenticated +
// SET LOCAL "request.jwt.claims" to a payload that auth.uid() can parse.
// Service-role (default test connection) bypasses RLS but still has to
// pass assert_is_admin() which reads auth.uid(), so we set the claim
// explicitly.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env.LEDGER_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type PgErr = { code?: string; message?: string };

async function asJwtUser<T>(
  pool: pg.Pool,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role authenticated`);
    await client.query(
      `set local "request.jwt.claims" = $1`,
      [JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function seedUser(pool: pg.Pool, opts: { admin?: boolean } = {}): Promise<string> {
  const uid = randomUUID();
  await pool.query('insert into auth.users (id) values ($1)', [uid]);
  await pool.query(
    `insert into public.user_profiles (user_id, kyc_status, is_admin)
       values ($1, 'approved', $2)
     on conflict (user_id) do update set is_admin = excluded.is_admin`,
    [uid, opts.admin ?? false],
  );
  return uid;
}

async function callRpc<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.PoolClient,
  sql: string,
  params: unknown[],
): Promise<{ ok: true; rows: T[] } | { ok: false; err: PgErr }> {
  try {
    const res = await client.query<T>(sql, params);
    return { ok: true, rows: res.rows };
  } catch (e) {
    return { ok: false, err: e as PgErr };
  }
}

describeIfDb('assert_is_admin gate', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('non-admin caller gets 42501 from set_system_flag', async () => {
    const user = await seedUser(pool, { admin: false });
    const res = await asJwtUser(pool, user, async (c) =>
      callRpc(c, `select public.set_system_flag($1, $2, $3)`, [
        'deposits_frozen',
        false,
        'test',
      ]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.code).toBe('42501');
  });

  it('admin caller succeeds on set_system_flag', async () => {
    const admin = await seedUser(pool, { admin: true });
    const res = await asJwtUser(pool, admin, async (c) =>
      callRpc(c, `select public.set_system_flag($1, $2, $3)`, [
        'deposits_frozen',
        false,
        'integration-test',
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it('non-admin caller gets 42501 from admin_list_users', async () => {
    const user = await seedUser(pool, { admin: false });
    const res = await asJwtUser(pool, user, async (c) =>
      callRpc(c, `select * from public.admin_list_users(10, null)`, []),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.code).toBe('42501');
  });

  it('admin caller reads admin_list_users', async () => {
    const admin = await seedUser(pool, { admin: true });
    const res = await asJwtUser(pool, admin, async (c) =>
      callRpc<{ user_id: string }>(c, `select * from public.admin_list_users(10, null)`, []),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows.length).toBeGreaterThan(0);
  });
});

describeIfDb('admin_set_user_admin', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('admin can grant + revoke admin on another user', async () => {
    const admin = await seedUser(pool, { admin: true });
    const target = await seedUser(pool, { admin: false });

    await asJwtUser(pool, admin, async (c) => {
      const r = await callRpc(c, `select public.admin_set_user_admin($1, $2)`, [
        target,
        true,
      ]);
      expect(r.ok).toBe(true);
    });
    const { rows: granted } = await pool.query<{ is_admin: boolean }>(
      `select is_admin from public.user_profiles where user_id = $1`,
      [target],
    );
    expect(granted[0]!.is_admin).toBe(true);

    await asJwtUser(pool, admin, async (c) => {
      const r = await callRpc(c, `select public.admin_set_user_admin($1, $2)`, [
        target,
        false,
      ]);
      expect(r.ok).toBe(true);
    });
    const { rows: revoked } = await pool.query<{ is_admin: boolean }>(
      `select is_admin from public.user_profiles where user_id = $1`,
      [target],
    );
    expect(revoked[0]!.is_admin).toBe(false);
  });

  it('admin cannot demote themselves', async () => {
    const admin = await seedUser(pool, { admin: true });
    const res = await asJwtUser(pool, admin, async (c) =>
      callRpc(c, `select public.admin_set_user_admin($1, false)`, [admin]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.code).toBe('42501');
  });
});

describeIfDb('admin_override_kyc + apply_kyc_decision', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('admin_override_kyc flips status', async () => {
    const admin = await seedUser(pool, { admin: true });
    const target = await seedUser(pool, { admin: false });

    await asJwtUser(pool, admin, async (c) => {
      const r = await callRpc(c, `select public.admin_override_kyc($1, 'rejected')`, [
        target,
      ]);
      expect(r.ok).toBe(true);
    });

    const { rows } = await pool.query<{ kyc_status: string }>(
      `select kyc_status from public.user_profiles where user_id = $1`,
      [target],
    );
    expect(rows[0]!.kyc_status).toBe('rejected');
  });

  it('apply_kyc_decision is service-role only', async () => {
    const user = await seedUser(pool, { admin: false });
    const res = await asJwtUser(pool, user, async (c) =>
      callRpc(c, `select public.apply_kyc_decision($1, 'approved', null, null, null)`, [user]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.code).toBe('42501'); // insufficient_privilege
  });

  it('apply_kyc_decision via service role upserts status + geo', async () => {
    const target = await seedUser(pool, { admin: false });
    // No JWT — default test connection is service_role.
    await pool.query(
      `select public.apply_kyc_decision($1, 'approved', 'US', 'test', 'ref-1')`,
      [target],
    );
    const { rows } = await pool.query<{ kyc_status: string; geo_country: string }>(
      `select kyc_status, geo_country from public.user_profiles where user_id = $1`,
      [target],
    );
    expect(rows[0]!.kyc_status).toBe('approved');
    expect(rows[0]!.geo_country).toBe('US');
  });
});

describeIfDb('admin_rescue_orphan_deposit', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  function randomAddress(): string {
    return (
      '0x' +
      Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    );
  }
  function randomHash(): string {
    return (
      '0x' +
      Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    );
  }

  it('admin_ignore_orphan_deposit closes the row without a deposit', async () => {
    const admin = await seedUser(pool, { admin: true });
    const tx = randomHash();
    const { rows } = await pool.query<{ id: string }>(
      `select public.record_orphan_deposit($1::int, $2::text, $3::text, null, $4::bigint, $5::bigint) as id`,
      [8453, tx, randomAddress(), '10000000', 22],
    );
    const orphanId = rows[0]!.id;

    await asJwtUser(pool, admin, async (c) => {
      const r = await callRpc(c, `select public.admin_ignore_orphan_deposit($1, $2)`, [
        orphanId,
        'test:not-a-user',
      ]);
      expect(r.ok).toBe(true);
    });

    const { rows: closed } = await pool.query<{
      resolved_at: string | null;
      resolved_deposit_id: string | null;
      ignored_reason: string | null;
    }>(
      `select resolved_at, resolved_deposit_id, ignored_reason
         from public.crypto_orphan_deposits where id = $1`,
      [orphanId],
    );
    expect(closed[0]!.resolved_at).not.toBeNull();
    expect(closed[0]!.resolved_deposit_id).toBeNull();
    expect(closed[0]!.ignored_reason).toContain('test');
  });

  it('binds the sender address + credits the deposit atomically', async () => {
    const admin = await seedUser(pool, { admin: true });
    const target = await seedUser(pool, { admin: false });
    const from = randomAddress();
    const tx = randomHash();

    // Record an orphan — service-role direct.
    const { rows: orphanRows } = await pool.query<{ id: string }>(
      `select public.record_orphan_deposit($1::int, $2::text, $3::text, $4::text, $5::bigint, $6::bigint) as id`,
      [8453, tx, from, null, '50000000', 123],
    );
    const orphanId = orphanRows[0]!.id;

    await asJwtUser(pool, admin, async (c) => {
      const r = await callRpc(c, `select public.admin_rescue_orphan_deposit($1, $2)`, [
        orphanId,
        target,
      ]);
      expect(r.ok).toBe(true);
    });

    const { rows: resolved } = await pool.query<{
      resolved_at: string | null;
      resolved_deposit_id: string | null;
    }>(
      `select resolved_at, resolved_deposit_id
         from public.crypto_orphan_deposits where id = $1`,
      [orphanId],
    );
    expect(resolved[0]!.resolved_at).not.toBeNull();
    expect(resolved[0]!.resolved_deposit_id).not.toBeNull();

    // Verify the target user's wallet was credited.
    const { rows: wallet } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets
        where user_id = $1 and account = 'user_wallet' and currency = 'USDC'`,
      [target],
    );
    expect(BigInt(wallet[0]!.balance_micro)).toBeGreaterThanOrEqual(50_000_000n);
  });
});
