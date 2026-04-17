// Integration tests for the Phase 3 market lifecycle.
// Requires a running Postgres with migrations 0001 + 0002 + 0003 applied.
//
// Locally: scripts/ledger-integration.sh
// In CI: the `node` job provisions postgres:17 and calls the script.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { computeBinLadder, type Bin } from './ladder.js';

const DATABASE_URL = process.env.LEDGER_TEST_DATABASE_URL;
const shouldRun = Boolean(DATABASE_URL);
const describeIfDb = shouldRun ? describe : describe.skip;

function first<T extends pg.QueryResultRow>(res: pg.QueryResult<T>): T {
  const r = res.rows[0];
  if (!r) throw new Error(`expected ≥1 row, got ${res.rowCount}`);
  return r;
}

type SqlBin = {
  idx: number;
  low_price: string;
  high_price: string;
  is_tail_low: boolean;
  is_tail_high: boolean;
};

async function sqlLadder(pool: pg.Pool, lastPrice: number): Promise<Bin[]> {
  const { rows } = await pool.query<SqlBin>(
    `select idx, low_price::text, high_price::text, is_tail_low, is_tail_high
       from public.compute_bin_ladder($1::numeric)
       order by idx`,
    [lastPrice],
  );
  return rows.map((r) => ({
    idx: r.idx,
    lowPrice: Number(r.low_price),
    highPrice: Number(r.high_price),
    isTailLow: r.is_tail_low,
    isTailHigh: r.is_tail_high,
  }));
}

async function insertHalt(
  pool: pg.Pool,
  symbol: string,
  reasonCode: string,
  haltTime: Date,
  lastPrice: number | null,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    `select public.insert_halt($1, $2::halt_reason_code, $3, null, $4) as id`,
    [symbol, reasonCode, haltTime.toISOString(), lastPrice],
  );
  return rows[0]?.id ?? null;
}

async function marketIdForSymbol(pool: pg.Pool, symbol: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `select m.id from public.markets m
       join public.halts h on m.halt_id = h.id where h.symbol = $1`,
    [symbol],
  );
  return first(res).id;
}

describeIfDb('compute_bin_ladder: SQL matches TS mirror', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each([0.1, 0.5, 1, 4, 25, 250, 2500, 10_000])(
    'matches for last_price=%f',
    async (lastPrice) => {
      const sql = await sqlLadder(pool, lastPrice);
      const ts = computeBinLadder(lastPrice);
      expect(sql).toHaveLength(22);
      expect(ts).toHaveLength(22);
      for (let i = 0; i < 22; i++) {
        const sqlBin = sql[i];
        const tsBin = ts[i];
        if (!sqlBin || !tsBin) throw new Error(`missing bin at idx ${i}`);
        expect(sqlBin.idx).toBe(tsBin.idx);
        expect(sqlBin.lowPrice).toBeCloseTo(tsBin.lowPrice, 4);
        expect(sqlBin.highPrice).toBeCloseTo(tsBin.highPrice, 4);
        expect(sqlBin.isTailLow).toBe(tsBin.isTailLow);
        expect(sqlBin.isTailHigh).toBe(tsBin.isTailHigh);
      }
    },
  );

  it('rejects zero and negative last_price', async () => {
    await expect(sqlLadder(pool, 0)).rejects.toThrow();
    await expect(sqlLadder(pool, -1)).rejects.toThrow();
  });
});

describeIfDb('market lifecycle: halts-INSERT trigger', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('inserting a halt with last_price creates market + 22 bins atomically', async () => {
    const sym = `HMT${Math.floor(Math.random() * 1_000_000_000)}`;
    const haltId = await insertHalt(pool, sym, 'LUDP', new Date(), 4);
    expect(haltId).toBeTruthy();

    const mk = first(
      await pool.query<{
        market_id: string;
        status: string;
        last_price: string;
        closes_at: Date;
        opened_at: Date;
      }>(
        `select id as market_id, status::text, last_price::text, closes_at, opened_at
           from public.markets where halt_id = $1`,
        [haltId],
      ),
    );
    expect(mk.status).toBe('open');
    expect(Number(mk.last_price)).toBe(4);
    const delta = mk.closes_at.getTime() - mk.opened_at.getTime();
    expect(Math.abs(delta - 90_000)).toBeLessThan(2_000);

    const binCount = first(
      await pool.query<{ count: string }>(
        `select count(*)::text from public.bins where market_id = $1`,
        [mk.market_id],
      ),
    );
    expect(Number(binCount.count)).toBe(22);
  });

  it('LUDP halt without last_price skips market creation', async () => {
    // Exercises create_market()'s `last_price IS NULL → return NULL` guard
    // without also tripping the halt_kind gate (that's covered below).
    const sym = `NOP${Math.floor(Math.random() * 1_000_000_000)}`;
    const haltId = await insertHalt(pool, sym, 'LUDP', new Date(), null);
    expect(haltId).toBeTruthy();
    const { rowCount } = await pool.query(
      `select 1 from public.markets where halt_id = $1`,
      [haltId],
    );
    expect(rowCount).toBe(0);
  });

  it('create_market is idempotent (second call returns same id)', async () => {
    const sym = `IDEM${Math.floor(Math.random() * 1_000_000_000)}`;
    const haltId = await insertHalt(pool, sym, 'LUDP', new Date(), 10);
    const firstMk = first(
      await pool.query<{ id: string }>(
        `select id from public.markets where halt_id = $1`,
        [haltId],
      ),
    );
    const again = first(
      await pool.query<{ id: string }>(
        `select public.create_market($1) as id`,
        [haltId],
      ),
    );
    expect(again.id).toBe(firstMk.id);
    const binCount = first(
      await pool.query<{ count: string }>(
        `select count(*)::text from public.bins where market_id = $1`,
        [firstMk.id],
      ),
    );
    expect(Number(binCount.count)).toBe(22);
  });
});

describeIfDb('halt_kind launch-scope gate — only LUDP creates markets', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function expectNoMarket(
    reasonCode: string,
    prefix: string,
  ): Promise<void> {
    const sym = `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
    // Supply a valid last_price so the no-market outcome is driven by the
    // halt_kind trigger gate, not by the function's null-last-price guard.
    const haltId = await insertHalt(pool, sym, reasonCode, new Date(), 25);
    expect(haltId).toBeTruthy();
    const { rowCount } = await pool.query(
      `select 1 from public.markets where halt_id = $1`,
      [haltId],
    );
    expect(rowCount).toBe(0);
  }

  it('T1 news halt does not create a market', async () => {
    await expectNoMarket('T1', 'T1');
  });

  it('T12 news halt does not create a market', async () => {
    await expectNoMarket('T12', 'T12');
  });

  it('H10 regulatory halt does not create a market', async () => {
    await expectNoMarket('H10', 'H10');
  });

  it('LUDP volatility halt does create a market (sanity, inverse of above)', async () => {
    const sym = `GATE${Math.floor(Math.random() * 1_000_000_000)}`;
    const haltId = await insertHalt(pool, sym, 'LUDP', new Date(), 25);
    expect(haltId).toBeTruthy();
    const { rowCount } = await pool.query(
      `select 1 from public.markets where halt_id = $1`,
      [haltId],
    );
    expect(rowCount).toBe(1);
  });
});

describeIfDb('market status state machine', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function freshMarket(lastPrice = 4): Promise<string> {
    const sym = `SM${Math.floor(Math.random() * 1_000_000_000)}`;
    await pool.query(
      `select public.insert_halt($1, 'LUDP'::halt_reason_code, now(), null, $2)`,
      [sym, lastPrice],
    );
    return marketIdForSymbol(pool, sym);
  }

  it('open → locked is allowed', async () => {
    const mid = await freshMarket();
    await pool.query(
      `update public.markets set status = 'locked', locked_at = now() where id = $1`,
      [mid],
    );
    const row = first(
      await pool.query<{ status: string }>(
        `select status::text from public.markets where id = $1`,
        [mid],
      ),
    );
    expect(row.status).toBe('locked');
  });

  it('locked → open is rejected', async () => {
    const mid = await freshMarket();
    await pool.query(
      `update public.markets set status = 'locked', locked_at = now() where id = $1`,
      [mid],
    );
    await expect(
      pool.query(
        `update public.markets set status = 'open', locked_at = null where id = $1`,
        [mid],
      ),
    ).rejects.toThrow(/illegal market status transition locked -> open/i);
  });

  it('open → resolved directly is rejected (must go through locked)', async () => {
    const mid = await freshMarket();
    await expect(
      pool.query(
        `update public.markets
            set status = 'resolved', locked_at = now(), resolved_at = now()
          where id = $1`,
        [mid],
      ),
    ).rejects.toThrow(/illegal market status transition open -> resolved/i);
  });

  it('fee_bps + closest_bonus_bps must be < 10000', async () => {
    const haltId = randomUUID();
    await expect(
      pool.query(
        `insert into public.markets
            (halt_id, last_price, closes_at, fee_bps, closest_bonus_bps)
         values ($1, 10.0, now() + interval '90 seconds', 5000, 5000)`,
        [haltId],
      ),
    ).rejects.toThrow(/markets_fee_plus_bonus_under_10000/);
  });
});

describeIfDb('lock_due_markets() scheduler', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('transitions expired-open markets to locked', async () => {
    const sym = `LK${Math.floor(Math.random() * 1_000_000_000)}`;
    await pool.query(
      `select public.insert_halt(
         $1, 'LUDP'::halt_reason_code, now() - interval '5 minutes', null, 12.5
       )`,
      [sym],
    );
    const pre = first(
      await pool.query<{ status: string }>(
        `select m.status::text
           from public.markets m join public.halts h on m.halt_id = h.id
          where h.symbol = $1`,
        [sym],
      ),
    );
    expect(pre.status).toBe('open');

    const res = first(
      await pool.query<{ drained: number }>(
        `select public.lock_due_markets() as drained`,
      ),
    );
    expect(res.drained).toBeGreaterThanOrEqual(1);

    const post = first(
      await pool.query<{ status: string; locked_at_set: boolean }>(
        `select m.status::text, m.locked_at is not null as locked_at_set
           from public.markets m join public.halts h on m.halt_id = h.id
          where h.symbol = $1`,
        [sym],
      ),
    );
    expect(post.status).toBe('locked');
    expect(post.locked_at_set).toBe(true);
  });

  it('leaves future-closing markets untouched', async () => {
    const sym = `FU${Math.floor(Math.random() * 1_000_000_000)}`;
    await pool.query(
      `select public.insert_halt($1, 'LUDP'::halt_reason_code, now(), null, 25)`,
      [sym],
    );
    await pool.query(`select public.lock_due_markets()`);
    const m = first(
      await pool.query<{ status: string }>(
        `select m.status::text
           from public.markets m join public.halts h on m.halt_id = h.id
          where h.symbol = $1`,
        [sym],
      ),
    );
    expect(m.status).toBe('open');
  });
});

describeIfDb('find_bin_for_price', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('maps the ADR-0002 worked example to bin 11', async () => {
    const sym = `ADR${Math.floor(Math.random() * 1_000_000_000)}`;
    await pool.query(
      `select public.insert_halt($1, 'LUDP'::halt_reason_code, now(), null, 4)`,
      [sym],
    );
    const marketId = await marketIdForSymbol(pool, sym);
    const bin = first(
      await pool.query<{ idx: number }>(
        `select b.idx
           from public.bins b
          where b.id = public.find_bin_for_price($1, 4.27::numeric)`,
        [marketId],
      ),
    );
    expect(bin.idx).toBe(11);
  });

  it('tail-low catches prices below 0.5P', async () => {
    const sym = `TL${Math.floor(Math.random() * 1_000_000_000)}`;
    await pool.query(
      `select public.insert_halt($1, 'LUDP'::halt_reason_code, now(), null, 10)`,
      [sym],
    );
    const marketId = await marketIdForSymbol(pool, sym);
    const bin = first(
      await pool.query<{ idx: number; is_tail_low: boolean }>(
        `select b.idx, b.is_tail_low
           from public.bins b
          where b.id = public.find_bin_for_price($1, 2.5::numeric)`,
        [marketId],
      ),
    );
    expect(bin.idx).toBe(0);
    expect(bin.is_tail_low).toBe(true);
  });

  it('tail-high catches prices above 2P', async () => {
    const sym = `TH${Math.floor(Math.random() * 1_000_000_000)}`;
    await pool.query(
      `select public.insert_halt($1, 'LUDP'::halt_reason_code, now(), null, 10)`,
      [sym],
    );
    const marketId = await marketIdForSymbol(pool, sym);
    const bin = first(
      await pool.query<{ idx: number; is_tail_high: boolean }>(
        `select b.idx, b.is_tail_high
           from public.bins b
          where b.id = public.find_bin_for_price($1, 25::numeric)`,
        [marketId],
      ),
    );
    expect(bin.idx).toBe(21);
    expect(bin.is_tail_high).toBe(true);
  });
});
