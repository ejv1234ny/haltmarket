// Integration tests for the Phase 1 ledger RPC. Requires a running Postgres
// with migration 0001_ledger.sql applied. The runner wires up a minimal auth
// schema (stub `auth.users` + `auth.uid()`) before applying the migration.
//
// Gate: these tests only run when LEDGER_TEST_DATABASE_URL is set. Locally:
//     scripts/ledger-integration.sh
// In CI: the `node` job provisions a postgres:17 service and runs the script.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  classifyPostTransferError,
  createLedgerClient,
  LedgerError,
  serializeLegs,
  transfers,
  type LedgerRpcClient,
  type PostgrestLikeError,
  type TransferLeg,
} from './index.js';

const DATABASE_URL = process.env.LEDGER_TEST_DATABASE_URL;
const shouldRun = Boolean(DATABASE_URL);

const describeIfDb = shouldRun ? describe : describe.skip;

function buildRpc(pool: pg.Pool): LedgerRpcClient {
  return {
    async rpc(fn, args) {
      try {
        const result = await pool.query(
          `select public.${fn}($1::uuid, $2::jsonb, $3::text)`,
          [args.p_txn_id, JSON.stringify(args.p_legs), args.p_reason],
        );
        void result;
        return { error: null };
      } catch (err) {
        const pgErr = err as { code?: string; message: string };
        const e: PostgrestLikeError = {
          code: pgErr.code,
          message: pgErr.message,
        };
        return { error: e };
      }
    },
  };
}

describeIfDb('ledger integration (post_transfer)', () => {
  let pool: pg.Pool;
  let userIds: string[] = [];
  const marketId = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // Seed a handful of auth.users rows.
    userIds = Array.from({ length: 8 }, () => randomUUID());
    const { rows: existing } = await pool.query<{ id: string }>(
      'select id from auth.users',
    );
    if (existing.length < userIds.length) {
      await pool.query(
        'insert into auth.users (id) select unnest($1::uuid[])',
        [userIds],
      );
    }
    // Seed each user with $1000 so bet/withdrawal tests have balance to spend.
    const client = createLedgerClient(buildRpc(pool));
    for (const uid of userIds) {
      await client.postTransfer({
        txnId: randomUUID(),
        legs: transfers.deposit({
          userId: uid,
          currency: 'USDC',
          amountMicro: 1_000_000_000n,
        }),
        reason: 'test:seed-deposit',
      });
    }
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  it('deposit → user_wallet balance reflects entry', async () => {
    const uid = userIds[0]!;
    const { rows } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets
         where user_id = $1 and account = 'user_wallet'`,
      [uid],
    );
    expect(rows[0]!.balance_micro).toBe('1000000000');
  });

  it('bet placement debits user, credits market_pool', async () => {
    const client = createLedgerClient(buildRpc(pool));
    const uid = userIds[1]!;
    await client.postTransfer({
      txnId: randomUUID(),
      legs: transfers.betPlacement({
        userId: uid,
        marketId,
        currency: 'USDC',
        stakeMicro: 10_000_000n,
      }),
      reason: 'bet:place',
    });
    const { rows } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets
         where user_id = $1 and account = 'user_wallet'`,
      [uid],
    );
    expect(rows[0]!.balance_micro).toBe('990000000');
    const { rows: poolRows } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets
         where user_id is null and account = 'market_pool' and currency = 'USDC'`,
    );
    expect(BigInt(poolRows[0]!.balance_micro)).toBeGreaterThanOrEqual(
      10_000_000n,
    );
  });

  it('duplicate txn_id → LedgerError(duplicate_txn_id)', async () => {
    const client = createLedgerClient(buildRpc(pool));
    const uid = userIds[2]!;
    const txnId = randomUUID();
    const legs = transfers.betPlacement({
      userId: uid,
      marketId,
      currency: 'USDC',
      stakeMicro: 1_000_000n,
    });
    await client.postTransfer({ txnId, legs, reason: 'bet:place' });
    await expect(
      client.postTransfer({ txnId, legs, reason: 'bet:place' }),
    ).rejects.toMatchObject({ code: 'duplicate_txn_id' });
  });

  it('overdraft → LedgerError(overdraft), ledger state unchanged', async () => {
    const client = createLedgerClient(buildRpc(pool));
    const uid = userIds[3]!;
    const before = await pool.query<{ c: string }>(
      `select count(*)::text as c from public.ledger_entries`,
    );
    await expect(
      client.postTransfer({
        txnId: randomUUID(),
        legs: transfers.betPlacement({
          userId: uid,
          marketId,
          currency: 'USDC',
          stakeMicro: 999_999_999_999n,
        }),
        reason: 'bet:place',
      }),
    ).rejects.toMatchObject({ code: 'overdraft' });
    const after = await pool.query<{ c: string }>(
      `select count(*)::text as c from public.ledger_entries`,
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });

  it('unbalanced legs rejected server-side too (raw RPC bypass of client check)', async () => {
    // Bypass client-side validation to prove the server enforces.
    const legs: TransferLeg[] = [
      {
        userId: userIds[4]!,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: -10n,
      },
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: 9n,
      },
    ];
    try {
      await pool.query(
        `select public.post_transfer($1::uuid, $2::jsonb, 'bet:place')`,
        [randomUUID(), JSON.stringify(serializeLegs(legs))],
      );
      throw new Error('expected failure');
    } catch (err) {
      const e = err as { code?: string; message: string };
      const ledgerErr = classifyPostTransferError({
        code: e.code,
        message: e.message,
      });
      expect(ledgerErr).toBeInstanceOf(LedgerError);
      expect(ledgerErr.code).toBe('unbalanced_legs');
    }
  });

  it('market resolution: N-leg atomic transfer (fee + 2 winners)', async () => {
    const client = createLedgerClient(buildRpc(pool));
    const winnerA = userIds[5]!;
    const winnerB = userIds[6]!;
    // Both winners stake first so there's pool money.
    const resolutionMarket = randomUUID();
    for (const uid of [winnerA, winnerB]) {
      await client.postTransfer({
        txnId: randomUUID(),
        legs: transfers.betPlacement({
          userId: uid,
          marketId: resolutionMarket,
          currency: 'USDC',
          stakeMicro: 100_000_000n,
        }),
        reason: 'bet:place',
      });
    }
    // Resolution: 200M pool → 10M fee, 120M winnerA, 70M winnerB.
    const resolutionLegs: TransferLeg[] = [
      {
        userId: null,
        account: 'market_pool',
        currency: 'USDC',
        amountMicro: -200_000_000n,
        refMarketId: resolutionMarket,
      },
      {
        userId: null,
        account: 'house_fees',
        currency: 'USDC',
        amountMicro: 10_000_000n,
        refMarketId: resolutionMarket,
      },
      {
        userId: winnerA,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: 120_000_000n,
        refMarketId: resolutionMarket,
      },
      {
        userId: winnerB,
        account: 'user_wallet',
        currency: 'USDC',
        amountMicro: 70_000_000n,
        refMarketId: resolutionMarket,
      },
    ];
    await client.postTransfer({
      txnId: randomUUID(),
      legs: resolutionLegs,
      reason: 'market:resolve',
    });
    const { rows } = await pool.query<{ s: string }>(
      `select coalesce(sum(amount_micro),0)::text as s
         from public.ledger_entries where ref_market_id = $1`,
      [resolutionMarket],
    );
    expect(rows[0]!.s).toBe('0');
  });

  it('concurrency: 20 parallel bets on one user — no overdraft, total debited = sum of accepted', async () => {
    const uid = userIds[7]!;
    // Fresh account: top up to a clean 1_000_000n (we only allow 10 bets of 100_000n).
    const startRes = await pool.query<{ b: string }>(
      `select balance_micro::text as b from public.wallets
         where user_id = $1 and account = 'user_wallet'`,
      [uid],
    );
    const startBal = BigInt(startRes.rows[0]!.b);
    // We'll place 20 bets of 100_000n each — that is 2_000_000 total demanded.
    // Some must fail (overdraft) because balance is 1_000_000n after reset.
    // First, drain excess to a known starting balance.
    const drainTarget = 1_000_000n;
    if (startBal > drainTarget) {
      const drain = startBal - drainTarget;
      // Drain via a synthetic pool→withdrawal pending (doesn't overdraft).
      const drainMarket = randomUUID();
      await pool.query(
        `select public.post_transfer($1::uuid, $2::jsonb, 'test:drain')`,
        [
          randomUUID(),
          JSON.stringify(
            serializeLegs(
              transfers.betPlacement({
                userId: uid,
                marketId: drainMarket,
                currency: 'USDC',
                stakeMicro: drain,
              }),
            ),
          ),
        ],
      );
    }

    const client = createLedgerClient(buildRpc(pool));
    const stake = 100_000n;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        client.postTransfer({
          txnId: randomUUID(),
          legs: transfers.betPlacement({
            userId: uid,
            marketId,
            currency: 'USDC',
            stakeMicro: stake,
          }),
          reason: 'bet:place',
        }),
      ),
    );
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected');

    // Every rejection must be an overdraft, not something else.
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason as LedgerError;
      expect(err.code).toBe('overdraft');
    }

    const endRes = await pool.query<{ b: string }>(
      `select balance_micro::text as b from public.wallets
         where user_id = $1 and account = 'user_wallet'`,
      [uid],
    );
    const endBal = BigInt(endRes.rows[0]!.b);
    // Accepted bets moved accepted*stake out; balance stays non-negative.
    expect(endBal).toBe(1_000_000n - BigInt(accepted) * stake);
    expect(endBal).toBeGreaterThanOrEqual(0n);
    // At most 10 bets of 100_000n fit in a 1_000_000n balance.
    expect(accepted).toBeLessThanOrEqual(10);
    expect(accepted).toBeGreaterThan(0);
  }, 30_000);

  it('failure injection: intra-transaction rollback leaves no partial ledger state', async () => {
    // Wrap post_transfer in an explicit txn and ROLLBACK after it.
    const client = await pool.connect();
    const txnId = randomUUID();
    try {
      await client.query('begin');
      await client.query(
        `select public.post_transfer($1::uuid, $2::jsonb, 'test:rollback')`,
        [
          txnId,
          JSON.stringify(
            serializeLegs(
              transfers.betPlacement({
                userId: userIds[0]!,
                marketId,
                currency: 'USDC',
                stakeMicro: 500n,
              }),
            ),
          ),
        ],
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ c: string }>(
      `select count(*)::text as c from public.ledger_entries where txn_id = $1`,
      [txnId],
    );
    expect(rows[0]!.c).toBe('0');
    const { rows: tRows } = await pool.query<{ c: string }>(
      `select count(*)::text as c from public.ledger_transfers where txn_id = $1`,
      [txnId],
    );
    expect(tRows[0]!.c).toBe('0');
  });

  it('global invariant: SUM(amount_micro) = 0 after all tests', async () => {
    const { rows } = await pool.query<{ s: string }>(
      `select coalesce(sum(amount_micro),0)::text as s from public.ledger_entries`,
    );
    expect(rows[0]!.s).toBe('0');
    const { rows: drift } = await pool.query(
      `select * from public.ledger_wallet_drift(10000)`,
    );
    expect(drift).toHaveLength(0);
  });

  it('ledger_entries is structurally append-only (UPDATE blocked)', async () => {
    await expect(
      pool.query(`update public.ledger_entries set amount_micro = 0 where true`),
    ).rejects.toThrow(/append-only/);
  });

  it('ledger_entries is structurally append-only (DELETE blocked)', async () => {
    await expect(
      pool.query(`delete from public.ledger_entries where true`),
    ).rejects.toThrow(/append-only/);
  });
});

if (!shouldRun) {
  describe.skip('ledger integration (skipped: LEDGER_TEST_DATABASE_URL unset)', () => {
    it('placeholder', () => {
      expect(true).toBe(true);
    });
  });
}
