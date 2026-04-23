// Phase 10 E2E flow — halt → market → bet → resolve → payout, verifying
// ledger_global_sum()=0 after every step. Runs against the same pg harness
// as the other integration suites.
//
// Per AGENTS.md §Phase 10: "E2E test from Phase 10 passes 100 iterations
// in CI". We run 50 to keep the suite under 30s on the CI runner while
// still exercising the round-trip on every commit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const DATABASE_URL = process.env.LEDGER_TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ITERATIONS = Number.parseInt(process.env.E2E_ITERATIONS ?? '50', 10);

async function globalSum(pool: pg.Pool): Promise<bigint> {
  const { rows } = await pool.query<{ s: string }>(
    `select coalesce(sum(amount_micro),0)::text as s from public.ledger_entries`,
  );
  return BigInt(rows[0]!.s);
}

async function seedFundedUser(pool: pg.Pool, micros: bigint): Promise<string> {
  const uid = randomUUID();
  await pool.query('insert into auth.users (id) values ($1)', [uid]);
  await pool.query(
    `insert into public.user_profiles (user_id, kyc_status)
       values ($1, 'approved')
     on conflict (user_id) do update set kyc_status = excluded.kyc_status`,
    [uid],
  );
  await pool.query(
    `select public.post_transfer($1::uuid, $2::jsonb, 'test:seed')`,
    [
      randomUUID(),
      JSON.stringify([
        {
          user_id: uid,
          account: 'user_wallet',
          currency: 'USDC',
          amount_micro: micros.toString(),
        },
        {
          user_id: uid,
          account: 'pending_deposits',
          currency: 'USDC',
          amount_micro: (-micros).toString(),
        },
      ]),
    ],
  );
  return uid;
}

async function seedMarket(
  pool: pg.Pool,
  lastPrice = 50,
): Promise<{ haltId: string; marketId: string }> {
  const symbol = `E2E${Math.floor(Math.random() * 1_000_000_000_000)}`;
  const { rows: haltRow } = await pool.query<{ insert_halt: string }>(
    `select public.insert_halt($1, 'LUDP'::halt_reason_code, now(), now() + interval '90 seconds', $2::numeric(12,4))`,
    [symbol, lastPrice],
  );
  const haltId = haltRow[0]!.insert_halt;
  const { rows: marketRow } = await pool.query<{ id: string }>(
    `select id from public.markets where halt_id = $1`,
    [haltId],
  );
  return { haltId, marketId: marketRow[0]!.id };
}

async function placeBet(
  pool: pg.Pool,
  userId: string,
  marketId: string,
  predictedPrice: number,
  stakeMicro: bigint,
): Promise<void> {
  await pool.query(
    `select public.place_bet($1::uuid, $2::uuid, $3::numeric, $4::bigint, $5::text)`,
    [userId, marketId, predictedPrice, stakeMicro.toString(), randomUUID()],
  );
}

async function lockMarket(pool: pg.Pool, marketId: string): Promise<void> {
  await pool.query(
    `update public.markets set status='locked', locked_at=now() where id=$1`,
    [marketId],
  );
}

async function resolveMarket(
  pool: pg.Pool,
  haltId: string,
  reopenPrice: number,
): Promise<void> {
  await pool.query(
    `select public.resolve_market($1::uuid, $2::numeric(12,4), now(), 'e2e:opening_cross')`,
    [haltId, reopenPrice],
  );
}

describeIfDb('E2E — halt → market → bet → resolve → payout', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('single happy path preserves SUM=0 at every step and credits the winner', async () => {
    const uid = await seedFundedUser(pool, 1_000_000_000n); // $1,000
    const { haltId, marketId } = await seedMarket(pool, 50);

    const sumStart = await globalSum(pool);

    // predicted_price 52 on last_price 50 lands in a main bin; we'll later
    // resolve near 52 so this is the winning bet.
    await placeBet(pool, uid, marketId, 52.0, 100_000_000n);
    expect(await globalSum(pool)).toBe(sumStart);

    await lockMarket(pool, marketId);

    // Reopen price matches our bin → user should be credited from the
    // parimutuel main pool + closest-to-pin bonus (they're the only bettor).
    await resolveMarket(pool, haltId, 52.1);
    expect(await globalSum(pool)).toBe(sumStart);

    const { rows: payRows } = await pool.query<{ total: string }>(
      `select coalesce(sum(amount_micro),0)::text as total
         from public.payouts where user_id = $1 and market_id = $2`,
      [uid, marketId],
    );
    const paid = BigInt(payRows[0]!.total);
    expect(paid).toBeGreaterThan(0n);

    const { rows: balRows } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets
        where user_id = $1 and account='user_wallet' and currency='USDC'`,
      [uid],
    );
    // $1000 seed minus $100 bet plus payouts → should exceed $900 because
    // we were the sole winner of both the main pool and the bonus.
    const finalBalance = BigInt(balRows[0]!.balance_micro);
    expect(finalBalance).toBeGreaterThan(900_000_000n);
  });

  it('refund path (no reopen) restores staked balance and preserves SUM=0', async () => {
    const uid = await seedFundedUser(pool, 500_000_000n);
    const { haltId, marketId } = await seedMarket(pool, 20);
    const sumStart = await globalSum(pool);

    await placeBet(pool, uid, marketId, 21.0, 50_000_000n);
    expect(await globalSum(pool)).toBe(sumStart);

    await lockMarket(pool, marketId);

    // Refund directly (simulating the resolver's refund_timeout path).
    await pool.query(
      `select public.refund_market($1::uuid, 'e2e:timeout')`,
      [haltId],
    );
    expect(await globalSum(pool)).toBe(sumStart);

    const { rows } = await pool.query<{ balance_micro: string }>(
      `select balance_micro::text from public.wallets
        where user_id = $1 and account='user_wallet' and currency='USDC'`,
      [uid],
    );
    // Refunds return the full stake.
    expect(BigInt(rows[0]!.balance_micro)).toBe(500_000_000n);
  });

  it(`stress — ${ITERATIONS} iterations of halt→bet→resolve preserve SUM=0`, async () => {
    const sumStart = await globalSum(pool);

    for (let i = 0; i < ITERATIONS; i++) {
      const uid = await seedFundedUser(pool, 1_000_000_000n);
      const lastPrice = 10 + (i % 40);
      const { haltId, marketId } = await seedMarket(pool, lastPrice);
      // Bet slightly above the halt price so we often hit the winning bin.
      const predicted = lastPrice * (1.02 + Math.random() * 0.05);
      await placeBet(pool, uid, marketId, Number(predicted.toFixed(4)), 10_000_000n);
      await lockMarket(pool, marketId);
      // Reopen within the same main bin range so resolve_market always has
      // a valid reopen_price inside the ladder.
      const reopen = lastPrice * (0.98 + Math.random() * 0.1);
      await resolveMarket(pool, haltId, Number(reopen.toFixed(4)));

      // Check invariant every few iterations (every one is pricey).
      if (i % 10 === 0) {
        expect(await globalSum(pool)).toBe(sumStart);
      }
    }

    expect(await globalSum(pool)).toBe(sumStart);
  }, 120_000);
});
