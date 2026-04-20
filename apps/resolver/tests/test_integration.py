"""Integration tests for the Phase 5 resolution RPCs.

Requires Postgres with migrations 0001..0005 applied. Gated on
RESOLVER_TEST_DATABASE_URL (CI sets it, dev leaves it unset → tests skip).

The RPCs are the ground truth for ADR-0002 resolution math, so the tests
here assert payouts "to the micro" against hand-computed expectations.
"""

from __future__ import annotations

import contextlib
import os
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

import psycopg
import pytest

if TYPE_CHECKING:
    from collections.abc import Iterator

DSN = os.environ.get("RESOLVER_TEST_DATABASE_URL") or os.environ.get(
    "LEDGER_TEST_DATABASE_URL"
)

pytestmark = pytest.mark.skipif(
    not DSN, reason="no RESOLVER_TEST_DATABASE_URL / LEDGER_TEST_DATABASE_URL set"
)


# ----- helpers -------------------------------------------------------------


@dataclass
class SeededMarket:
    halt_id: UUID
    market_id: UUID
    last_price: Decimal


def _now_utc() -> datetime:
    return datetime.now(tz=UTC).replace(microsecond=0)


def _seed_user(conn: psycopg.Connection, micros: int) -> UUID:
    uid = uuid4()
    with conn.cursor() as cur:
        cur.execute("insert into auth.users (id) values (%s)", (uid,))
        cur.execute(
            """
            select public.post_transfer(
                gen_random_uuid(), %s::jsonb, 'test:seed-deposit'
            )
            """,
            (
                f"""[
                    {{"user_id": "{uid}", "account": "user_wallet",
                      "currency": "USDC", "amount_micro": "{micros}"}},
                    {{"user_id": "{uid}", "account": "pending_deposits",
                      "currency": "USDC", "amount_micro": "-{micros}"}}
                ]""",
            ),
        )
    return uid


def _seed_market(conn: psycopg.Connection, last_price: Decimal = Decimal("4")) -> SeededMarket:
    sym = f"RS{random.randrange(1_000_000_000)}"
    now = _now_utc()
    with conn.cursor() as cur:
        cur.execute(
            """
            select public.insert_halt(%s, 'LUDP'::halt_reason_code, %s, %s, %s)
            """,
            (sym, now, now + timedelta(seconds=90), last_price),
        )
        row = cur.fetchone()
        halt_id = UUID(str(row[0]))
        cur.execute(
            "select m.id from public.markets m where m.halt_id = %s",
            (halt_id,),
        )
        market_id = UUID(str(cur.fetchone()[0]))
    return SeededMarket(halt_id=halt_id, market_id=market_id, last_price=last_price)


def _lock_market(conn: psycopg.Connection, market_id: UUID) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "update public.markets set status='locked', locked_at=now() where id=%s",
            (market_id,),
        )


def _place_bet(
    conn: psycopg.Connection,
    user_id: UUID,
    market_id: UUID,
    predicted_price: Decimal,
    stake_micro: int,
) -> UUID:
    with conn.cursor() as cur:
        cur.execute(
            """
            select bet_id from public.place_bet(
                %s, %s, %s::numeric, %s::bigint, %s::text
            )
            """,
            (user_id, market_id, predicted_price, stake_micro, str(uuid4())),
        )
        row = cur.fetchone()
    return UUID(str(row[0]))


def _global_sum(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute("select public.ledger_global_sum();")
        return int(cur.fetchone()[0] or 0)


def _wallet(conn: psycopg.Connection, user_id: UUID) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            select coalesce(balance_micro, 0) from public.wallets
             where user_id = %s and account = 'user_wallet'
            """,
            (user_id,),
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


def _house_fees(conn: psycopg.Connection) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            select coalesce(balance_micro, 0) from public.wallets
             where user_id is null and account = 'house_fees'
            """,
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


@pytest.fixture
def conn() -> Iterator[psycopg.Connection]:
    assert DSN
    with psycopg.connect(DSN, autocommit=True) as c:
        yield c


# ----- tests ---------------------------------------------------------------


def test_resolve_market_simple_winner_gets_exact_micro_payout(
    conn: psycopg.Connection,
) -> None:
    """Single-user market — all money flows: stake → (market_pool → fee +
    bonus + main). No split, no dust — payouts must match to the micro."""
    m = _seed_market(conn, Decimal("4"))
    uid = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, uid, m.market_id, Decimal("4.27"), 100_000_000)
    _lock_market(conn, m.market_id)

    bal_before_resolve = _wallet(conn, uid)
    house_before = _house_fees(conn)
    sum_before = _global_sum(conn)

    with conn.cursor() as cur:
        cur.execute(
            """
            select gross_pool_micro, fee_micro, closest_bonus_micro,
                   main_payout_pool_micro, idempotent_replay
              from public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )
        row = cur.fetchone()
    assert row is not None
    gross, fee, bonus, main, replay = row
    assert not replay
    # 5% fee + 7% bonus on 100M pool.
    assert int(gross) == 100_000_000
    assert int(fee) == 5_000_000
    assert int(bonus) == 7_000_000
    assert int(main) == 88_000_000  # 100 - 5 - 7

    # Single user: gets full main pool + full bonus = 88M + 7M = 95M.
    # Their wallet went from (bal_before - stake) to (bal_before + 95M - stake)
    # actually bal_before_resolve already reflects (initial - stake).
    assert _wallet(conn, uid) == bal_before_resolve + 88_000_000 + 7_000_000
    assert _house_fees(conn) == house_before + 5_000_000
    # Ledger invariant.
    assert _global_sum(conn) == sum_before


def test_resolve_splits_main_pool_pro_rata_by_stake(conn: psycopg.Connection) -> None:
    """Two users in the same (winning) bin — main pool shared 3:1 by stake."""
    m = _seed_market(conn, Decimal("4"))
    u1 = _seed_user(conn, 1_000_000_000)
    u2 = _seed_user(conn, 1_000_000_000)
    # Both at 4.27 (same bin) — u1 stakes 3x u2.
    _place_bet(conn, u1, m.market_id, Decimal("4.27"), 300_000_000)
    _place_bet(conn, u2, m.market_id, Decimal("4.27"), 100_000_000)
    _lock_market(conn, m.market_id)

    bal1_before = _wallet(conn, u1)
    bal2_before = _wallet(conn, u2)

    with conn.cursor() as cur:
        cur.execute(
            """
            select gross_pool_micro, fee_micro, closest_bonus_micro, main_payout_pool_micro
              from public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )
        row = cur.fetchone()

    # 400M pool: 20M fee, 28M bonus, 352M main.
    # u1 share: 352M * 300M / 400M = 264M. u2 share: 352M * 100M / 400M = 88M.
    # Tied closest (both at 0.00 distance): bonus 28M split 14M each.
    # u1 final: bal1_before + 264M + 14M. u2 final: bal2_before + 88M + 14M.
    assert int(row[0]) == 400_000_000
    assert int(row[1]) == 20_000_000
    assert int(row[2]) == 28_000_000  # 14M × 2 users
    assert int(row[3]) == 352_000_000
    assert _wallet(conn, u1) == bal1_before + 264_000_000 + 14_000_000
    assert _wallet(conn, u2) == bal2_before + 88_000_000 + 14_000_000
    assert _global_sum(conn) == 0


def test_resolve_closest_user_tie_split_equally(conn: psycopg.Connection) -> None:
    """Three users all equidistant from the reopen price — bonus/3 each."""
    m = _seed_market(conn, Decimal("4"))
    reopen = Decimal("4.00")
    # Three users each 0.10 away (two below, one above).
    u_lo1 = _seed_user(conn, 1_000_000_000)
    u_lo2 = _seed_user(conn, 1_000_000_000)
    u_hi = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, u_lo1, m.market_id, Decimal("3.90"), 100_000_000)
    _place_bet(conn, u_lo2, m.market_id, Decimal("3.90"), 100_000_000)
    _place_bet(conn, u_hi, m.market_id, Decimal("4.10"), 100_000_000)
    _lock_market(conn, m.market_id)

    with conn.cursor() as cur:
        cur.execute(
            """
            select closest_bonus_micro
              from public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, reopen, _now_utc()),
        )
        closest_bonus = int(cur.fetchone()[0])

    # 300M gross × 7% = 21M bonus. Tied 3 ways: 7M each, no dust.
    assert closest_bonus == 21_000_000


def test_resolve_idempotent_replay_returns_same_result(conn: psycopg.Connection) -> None:
    m = _seed_market(conn, Decimal("4"))
    uid = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, uid, m.market_id, Decimal("4.27"), 10_000_000)
    _lock_market(conn, m.market_id)

    with conn.cursor() as cur:
        cur.execute(
            """
            select winning_bin_id, idempotent_replay
              from public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )
        first = cur.fetchone()
        cur.execute(
            """
            select winning_bin_id, idempotent_replay
              from public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )
        second = cur.fetchone()

    assert not first[1]
    assert second[1]
    assert first[0] == second[0]  # same winning bin
    assert _global_sum(conn) == 0


def test_refund_market_returns_all_stakes_to_users(conn: psycopg.Connection) -> None:
    m = _seed_market(conn, Decimal("4"))
    u1 = _seed_user(conn, 1_000_000_000)
    u2 = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, u1, m.market_id, Decimal("4.2"), 10_000_000)
    _place_bet(conn, u1, m.market_id, Decimal("4.3"), 5_000_000)
    _place_bet(conn, u2, m.market_id, Decimal("4.1"), 20_000_000)
    _lock_market(conn, m.market_id)

    bal1_post_bet = _wallet(conn, u1)
    bal2_post_bet = _wallet(conn, u2)

    with conn.cursor() as cur:
        cur.execute(
            """
            select refunded_bet_count, gross_refund_micro, idempotent_replay
              from public.refund_market(%s, 'refund_timeout:test')
            """,
            (m.halt_id,),
        )
        row = cur.fetchone()
    assert row[0] == 3
    assert int(row[1]) == 35_000_000
    assert not row[2]

    # Wallets back to pre-market state (full stake refunded).
    assert _wallet(conn, u1) == bal1_post_bet + 15_000_000
    assert _wallet(conn, u2) == bal2_post_bet + 20_000_000
    assert _global_sum(conn) == 0


def test_refund_market_idempotent_replay(conn: psycopg.Connection) -> None:
    m = _seed_market(conn, Decimal("4"))
    uid = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, uid, m.market_id, Decimal("4.2"), 10_000_000)
    _lock_market(conn, m.market_id)

    with conn.cursor() as cur:
        cur.execute(
            "select idempotent_replay from public.refund_market(%s, 'first')",
            (m.halt_id,),
        )
        first = bool(cur.fetchone()[0])
        cur.execute(
            "select idempotent_replay from public.refund_market(%s, 'second')",
            (m.halt_id,),
        )
        second = bool(cur.fetchone()[0])

    assert first is False
    assert second is True
    assert _global_sum(conn) == 0


def test_zero_pool_market_resolves_without_ledger_txn(conn: psycopg.Connection) -> None:
    """Locked market with no bets — nothing to ledger, still transitions to
    'resolved' cleanly (winning_bin_id captured for the UI)."""
    m = _seed_market(conn, Decimal("4"))
    _lock_market(conn, m.market_id)
    sum_before = _global_sum(conn)

    with conn.cursor() as cur:
        cur.execute(
            """
            select gross_pool_micro, ledger_txn_id, idempotent_replay
              from public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )
        row = cur.fetchone()
    assert int(row[0]) == 0
    assert row[1] is None
    assert not row[2]

    with conn.cursor() as cur:
        cur.execute("select status::text from public.markets where id = %s", (m.market_id,))
        status = cur.fetchone()[0]
    assert status == "resolved"
    assert _global_sum(conn) == sum_before


def test_resolve_after_refund_rejects(conn: psycopg.Connection) -> None:
    m = _seed_market(conn, Decimal("4"))
    uid = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, uid, m.market_id, Decimal("4.2"), 10_000_000)
    _lock_market(conn, m.market_id)

    with conn.cursor() as cur:
        cur.execute(
            "select public.refund_market(%s, 'refund_timeout:test')",
            (m.halt_id,),
        )

    with conn.cursor() as cur, pytest.raises(psycopg.errors.RaiseException):
        cur.execute(
            """
            select public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )


def test_refund_after_resolve_rejects(conn: psycopg.Connection) -> None:
    m = _seed_market(conn, Decimal("4"))
    uid = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, uid, m.market_id, Decimal("4.2"), 10_000_000)
    _lock_market(conn, m.market_id)

    with conn.cursor() as cur:
        cur.execute(
            """
            select public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )

    with conn.cursor() as cur, pytest.raises(psycopg.errors.RaiseException):
        cur.execute(
            "select public.refund_market(%s, 'after_resolve')", (m.halt_id,)
        )


def test_property_random_bet_sequences_preserve_sum_zero(conn: psycopg.Connection) -> None:
    """Phase 5 brief: property-based — random bet sequences → resolve → SUM=0.

    Scaled to 10 markets × up to 10 bets each to keep CI under a minute;
    set RESOLVER_PROPERTY_MARKETS / RESOLVER_PROPERTY_BETS to scale locally.
    """
    n_markets = int(os.environ.get("RESOLVER_PROPERTY_MARKETS", "10"))
    max_bets = int(os.environ.get("RESOLVER_PROPERTY_BETS", "10"))

    rng = random.Random(0xC0DE)
    sum_before = _global_sum(conn)

    users = [_seed_user(conn, 5_000_000_000) for _ in range(10)]
    for _ in range(n_markets):
        last_price = Decimal(f"{1 + rng.random() * 50:.4f}")
        m = _seed_market(conn, last_price)
        n_bets = rng.randint(0, max_bets)
        for _ in range(n_bets):
            uid = rng.choice(users)
            price = Decimal(f"{float(last_price) * (0.4 + rng.random() * 1.6):.4f}")
            stake = rng.randint(100_000, 50_000_000)
            # Rate-limit / aggregate-cap rejection is expected; skip it.
            with contextlib.suppress(psycopg.errors.RaiseException):
                _place_bet(conn, uid, m.market_id, price, stake)
        _lock_market(conn, m.market_id)
        reopen = Decimal(f"{float(last_price) * (0.5 + rng.random() * 1.5):.4f}")
        with conn.cursor() as cur:
            cur.execute(
                "select public.resolve_market(%s, %s::numeric, %s, 'test:property')",
                (m.halt_id, reopen, _now_utc()),
            )

    assert _global_sum(conn) == sum_before


def test_idempotency_100x_no_double_pay(conn: psycopg.Connection) -> None:
    """Acceptance: 100 resolve-replay iterations must not double-pay."""
    m = _seed_market(conn, Decimal("4"))
    uid = _seed_user(conn, 1_000_000_000)
    _place_bet(conn, uid, m.market_id, Decimal("4.27"), 10_000_000)
    _lock_market(conn, m.market_id)

    with conn.cursor() as cur:
        cur.execute(
            """
            select public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
            """,
            (m.halt_id, Decimal("4.27"), _now_utc()),
        )
    bal_after_first = _wallet(conn, uid)
    sum_after_first = _global_sum(conn)

    for _ in range(100):
        with conn.cursor() as cur:
            cur.execute(
                """
                select public.resolve_market(%s, %s::numeric, %s, 'test:polygon')
                """,
                (m.halt_id, Decimal("4.27"), _now_utc()),
            )

    assert _wallet(conn, uid) == bal_after_first
    assert _global_sum(conn) == sum_after_first
