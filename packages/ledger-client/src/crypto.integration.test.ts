// Integration tests for Phase 8 crypto-rail RPCs (migration 0008).
// Requires a running Postgres with 0001–0008 applied. Gated by
// LEDGER_TEST_DATABASE_URL like the other integration suites.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env.LEDGER_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type PgErr = { code?: string; message?: string };

async function seedUser(pool: pg.Pool): Promise<string> {
  const uid = randomUUID();
  await pool.query('insert into auth.users (id) values ($1)', [uid]);
  await pool.query(
    `insert into public.user_profiles (user_id, kyc_status)
      values ($1, 'approved')
     on conflict (user_id) do update set kyc_status = excluded.kyc_status`,
    [uid],
  );
  return uid;
}

async function mapAddress(
  pool: pg.Pool,
  userId: string,
  address: string,
  chainId = 8453,
): Promise<void> {
  await pool.query(
    `insert into public.user_wallet_addresses (user_id, chain_id, address, source)
      values ($1, $2, $3, 'ops')`,
    [userId, chainId, address],
  );
}

function randomHash(): string {
  return (
    '0x' +
    Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  );
}

function randomAddress(): string {
  return (
    '0x' +
    Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  );
}

async function globalSum(pool: pg.Pool): Promise<bigint> {
  const { rows } = await pool.query<{ s: string }>(
    `select coalesce(sum(amount_micro),0)::text as s from public.ledger_entries`,
  );
  return BigInt(rows[0]!.s);
}

async function creditDeposit(
  pool: pg.Pool,
  args: {
    chainId?: number;
    txHash: string;
    fromAddress: string;
    toAddress?: string;
    amountMicro: bigint;
    blockNumber?: number;
  },
): Promise<{ ok: true; id: string } | { ok: false; err: PgErr }> {
  try {
    const { rows } = await pool.query<{ credit_crypto_deposit: string }>(
      `select public.credit_crypto_deposit($1::int, $2::text, $3::text, $4::text, $5::bigint, $6::bigint)`,
      [
        args.chainId ?? 8453,
        args.txHash,
        args.fromAddress,
        args.toAddress ?? '0x' + '0'.repeat(39) + '1',
        args.amountMicro.toString(),
        args.blockNumber ?? 12345,
      ],
    );
    return { ok: true, id: rows[0]!.credit_crypto_deposit };
  } catch (e) {
    return { ok: false, err: e as PgErr };
  }
}

async function requestWithdrawal(
  pool: pg.Pool,
  args: { userId: string; amountMicro: bigint; destination?: string },
): Promise<{ ok: true; id: string } | { ok: false; err: PgErr }> {
  try {
    const { rows } = await pool.query<{ request_withdrawal: string }>(
      `select public.request_withdrawal($1::uuid, $2::bigint, $3::text, $4::int)`,
      [
        args.userId,
        args.amountMicro.toString(),
        args.destination ?? randomAddress(),
        8453,
      ],
    );
    return { ok: true, id: rows[0]!.request_withdrawal };
  } catch (e) {
    return { ok: false, err: e as PgErr };
  }
}

describeIfDb('credit_crypto_deposit', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('happy path — mapped sender, ledger balanced, wallet credited', async () => {
    const uid = await seedUser(pool);
    const from = randomAddress();
    await mapAddress(pool, uid, from);
    const before = await globalSum(pool);

    const res = await creditDeposit(pool, {
      txHash: randomHash(),
      fromAddress: from,
      amountMicro: 50_000_000n,
    });
    expect(res.ok).toBe(true);

    const after = await globalSum(pool);
    expect(after).toBe(before);

    const { rows } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets where user_id = $1 and account = 'user_wallet' and currency = 'USDC'`,
      [uid],
    );
    expect(BigInt(rows[0]!.balance_micro)).toBeGreaterThanOrEqual(50_000_000n);
  });

  it('idempotent on duplicate (chain_id, tx_hash) — returns the original id', async () => {
    const uid = await seedUser(pool);
    const from = randomAddress();
    await mapAddress(pool, uid, from);
    const tx = randomHash();

    const first = await creditDeposit(pool, {
      txHash: tx,
      fromAddress: from,
      amountMicro: 10_000_000n,
    });
    const second = await creditDeposit(pool, {
      txHash: tx,
      fromAddress: from,
      amountMicro: 10_000_000n,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.id).toBe(second.id);
    }
  });

  it('raises H0014 for unknown sender', async () => {
    const res = await creditDeposit(pool, {
      txHash: randomHash(),
      fromAddress: randomAddress(),
      amountMicro: 1_000_000n,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.code).toBe('H0014');
  });

  it('raises H0012 when lifetime cap exceeded', async () => {
    const uid = await seedUser(pool);
    const from = randomAddress();
    await mapAddress(pool, uid, from);

    // Default cap is $250 = 250_000_000 micros. One 200M deposit, then a 100M
    // deposit would exceed; confirm cap rejects the second.
    const first = await creditDeposit(pool, {
      txHash: randomHash(),
      fromAddress: from,
      amountMicro: 200_000_000n,
    });
    expect(first.ok).toBe(true);

    const second = await creditDeposit(pool, {
      txHash: randomHash(),
      fromAddress: from,
      amountMicro: 100_000_000n,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.err.code).toBe('H0012');
  });
});

describeIfDb('request_withdrawal → mark_withdrawal_paid', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function depositAndWithdraw(
    depositMicro: bigint,
    withdrawMicro: bigint,
  ): Promise<{ uid: string; withdrawalId: string }> {
    const uid = await seedUser(pool);
    const from = randomAddress();
    await mapAddress(pool, uid, from);
    await creditDeposit(pool, {
      txHash: randomHash(),
      fromAddress: from,
      amountMicro: depositMicro,
    });
    const w = await requestWithdrawal(pool, {
      userId: uid,
      amountMicro: withdrawMicro,
    });
    if (!w.ok) throw new Error(`withdrawal seed failed: ${w.err.code} ${w.err.message}`);
    return { uid, withdrawalId: w.id };
  }

  it('rejects withdrawal below the $5 minimum (H0017)', async () => {
    const uid = await seedUser(pool);
    const from = randomAddress();
    await mapAddress(pool, uid, from);
    await creditDeposit(pool, {
      txHash: randomHash(),
      fromAddress: from,
      amountMicro: 100_000_000n,
    });
    const res = await requestWithdrawal(pool, {
      userId: uid,
      amountMicro: 1_000_000n, // $1
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.code).toBe('H0017');
  });

  it('mark_withdrawal_paid closes the reservation; ledger stays balanced', async () => {
    const { withdrawalId } = await depositAndWithdraw(100_000_000n, 10_000_000n);
    const before = await globalSum(pool);
    await pool.query(
      `select public.mark_withdrawal_paid($1::uuid, $2::text, $3::bigint)`,
      [withdrawalId, randomHash(), 98765],
    );
    const after = await globalSum(pool);
    expect(after).toBe(before);

    const { rows } = await pool.query<{ status: string }>(
      `select status from public.withdrawals where id = $1`,
      [withdrawalId],
    );
    expect(rows[0]!.status).toBe('confirmed');
  });

  it('mark_withdrawal_failed restores balance to user_wallet', async () => {
    const { uid, withdrawalId } = await depositAndWithdraw(100_000_000n, 10_000_000n);

    const { rows: before } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets where user_id = $1 and account = 'user_wallet'`,
      [uid],
    );
    const preBal = BigInt(before[0]!.balance_micro);

    await pool.query(
      `select public.mark_withdrawal_failed($1::uuid, $2::text)`,
      [withdrawalId, 'test:abandoned'],
    );

    const { rows: after } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets where user_id = $1 and account = 'user_wallet'`,
      [uid],
    );
    const postBal = BigInt(after[0]!.balance_micro);
    expect(postBal - preBal).toBe(10_000_000n);

    const { rows: status } = await pool.query<{ status: string }>(
      `select status from public.withdrawals where id = $1`,
      [withdrawalId],
    );
    expect(status[0]!.status).toBe('failed');
  });

  it('mark_withdrawal_paid is idempotent', async () => {
    const { withdrawalId } = await depositAndWithdraw(100_000_000n, 10_000_000n);
    const tx = randomHash();
    await pool.query(
      `select public.mark_withdrawal_paid($1::uuid, $2::text, $3::bigint)`,
      [withdrawalId, tx, 11],
    );
    const sumAfterFirst = await globalSum(pool);
    // Second call: must not double-pay. `mark_withdrawal_paid` short-circuits
    // on status='confirmed' instead of re-posting.
    await pool.query(
      `select public.mark_withdrawal_paid($1::uuid, $2::text, $3::bigint)`,
      [withdrawalId, tx, 11],
    );
    const sumAfterSecond = await globalSum(pool);
    expect(sumAfterSecond).toBe(sumAfterFirst);
  });
});

describeIfDb('reconcile_crypto_ledger', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('reports ledger_custody_micro, in_flight_withdraw_micro, user_wallet_total_micro', async () => {
    const { rows } = await pool.query<{
      ledger_custody_micro: string;
      in_flight_withdraw_micro: string;
      user_wallet_total_micro: string;
    }>(`select * from public.reconcile_crypto_ledger()`);
    const r = rows[0]!;
    // Invariants: custody is non-positive (we store pending_deposits negative),
    // in-flight is non-negative, user_wallet_total >= 0.
    expect(BigInt(r.ledger_custody_micro) <= 0n).toBe(true);
    expect(BigInt(r.in_flight_withdraw_micro) >= 0n).toBe(true);
    expect(BigInt(r.user_wallet_total_micro) >= 0n).toBe(true);
  });
});
