// Postgres helpers for the real-data Playwright spec.
//
// These talk to the test Supabase (or any Postgres with 0001–0018 applied)
// directly. Used by globalSetup + test-body hooks to seed + advance state.
//
// Connection:
//   REAL_DB_URL — a Postgres URL with service-role access. Defaults to
//   the same `LEDGER_TEST_DATABASE_URL` the integration tests use. CI
//   provisions `postgres:17-alpine` so anything in migrations/ applies.

import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const REAL_DB_URL =
  process.env.REAL_DB_URL ??
  process.env.LEDGER_TEST_DATABASE_URL ??
  '';

export function dbEnabled(): boolean {
  return process.env.PLAYWRIGHT_USE_REAL_DB === '1' && REAL_DB_URL.length > 0;
}

export function pool(): pg.Pool {
  if (!REAL_DB_URL) throw new Error('REAL_DB_URL not set');
  return new pg.Pool({ connectionString: REAL_DB_URL });
}

export async function seedFundedApprovedUser(
  p: pg.Pool,
  fundMicros = 1_000_000_000n,
): Promise<string> {
  const uid = randomUUID();
  await p.query('insert into auth.users (id) values ($1)', [uid]);
  await p.query(
    `insert into public.user_profiles (user_id, kyc_status, is_admin)
       values ($1, 'approved', false)
     on conflict (user_id) do update set kyc_status = excluded.kyc_status`,
    [uid],
  );
  await p.query(
    `select public.post_transfer($1::uuid, $2::jsonb, 'playwright:seed')`,
    [
      randomUUID(),
      JSON.stringify([
        {
          user_id: uid,
          account: 'user_wallet',
          currency: 'USDC',
          amount_micro: fundMicros.toString(),
        },
        {
          user_id: uid,
          account: 'pending_deposits',
          currency: 'USDC',
          amount_micro: (-fundMicros).toString(),
        },
      ]),
    ],
  );
  return uid;
}

export interface SeededMarket {
  haltId: string;
  marketId: string;
  symbol: string;
  lastPrice: number;
}

export async function seedOpenMarket(p: pg.Pool, lastPrice = 50): Promise<SeededMarket> {
  const symbol = `E2E${Math.floor(Math.random() * 1_000_000_000)}`;
  const { rows: haltRow } = await p.query<{ insert_halt: string }>(
    `select public.insert_halt(
       $1, 'LUDP'::halt_reason_code, now(),
       now() + interval '90 seconds', $2::numeric(12,4)
     ) as insert_halt`,
    [symbol, lastPrice],
  );
  const haltId = haltRow[0]!.insert_halt;
  const { rows: marketRow } = await p.query<{ id: string; closes_at: string }>(
    `select id, closes_at from public.markets where halt_id = $1`,
    [haltId],
  );
  // Bump closes_at so the market stays open through the test.
  await p.query(
    `update public.markets set closes_at = now() + interval '5 minutes' where id = $1`,
    [marketRow[0]!.id],
  );
  return { haltId, marketId: marketRow[0]!.id, symbol, lastPrice };
}

export async function lockMarket(p: pg.Pool, marketId: string): Promise<void> {
  await p.query(
    `update public.markets set status='locked', locked_at=now() where id = $1`,
    [marketId],
  );
}

export async function resolveMarket(
  p: pg.Pool,
  haltId: string,
  reopenPrice: number,
): Promise<void> {
  await p.query(
    `select public.resolve_market(
       $1::uuid, $2::numeric(12,4), now(), 'playwright:opening_cross')`,
    [haltId, reopenPrice],
  );
}

export async function globalSum(p: pg.Pool): Promise<bigint> {
  const { rows } = await p.query<{ s: string }>(
    `select coalesce(sum(amount_micro),0)::text as s from public.ledger_entries`,
  );
  return BigInt(rows[0]!.s);
}
