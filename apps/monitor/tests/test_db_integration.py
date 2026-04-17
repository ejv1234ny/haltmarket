"""Integration tests for the Database client — exercise real Postgres.

Opt-in via MONITOR_TEST_DATABASE_URL. Skipped when unset so the default pytest
run in a dev box that has no Postgres stays green. CI sets the var and the
supabase job applies 0001_ledger.sql + 0002_halts.sql first.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from haltmarket_monitor.config import DEFAULT_LEADER_LOCK_KEY
from haltmarket_monitor.db import Database

DSN = os.environ.get("MONITOR_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DSN, reason="MONITOR_TEST_DATABASE_URL not set; skipping live-pg integration"
)


@pytest.fixture
def db() -> Database:
    assert DSN
    d = Database(DSN, DEFAULT_LEADER_LOCK_KEY + 7)  # offset so tests don't conflict
    yield d
    d.release_leadership()
    d.close()


def _now_utc() -> datetime:
    return datetime.now(tz=UTC).replace(microsecond=0)


def test_leader_election_single_process(db: Database) -> None:
    assert db.try_acquire_leadership() is True
    # Idempotent: a second call stays leader.
    assert db.try_acquire_leadership() is True


def test_two_connections_cannot_both_lead() -> None:
    assert DSN
    a = Database(DSN, DEFAULT_LEADER_LOCK_KEY + 11)
    b = Database(DSN, DEFAULT_LEADER_LOCK_KEY + 11)
    try:
        assert a.try_acquire_leadership() is True
        # Second connection must fail to acquire the same lock.
        assert b.try_acquire_leadership() is False
        # After releasing leader A, B should succeed.
        a.release_leadership()
        assert b.try_acquire_leadership() is True
    finally:
        a.release_leadership()
        a.close()
        b.release_leadership()
        b.close()


def test_insert_halt_returns_id_and_dedups(db: Database) -> None:
    db.try_acquire_leadership()
    halt_time = _now_utc()
    first = db.insert_halt(
        symbol="HMKTTST",
        reason_code="LUDP",
        halt_time=halt_time,
        halt_end_time=None,
        last_price=Decimal("4.0000"),
    )
    assert first is not None
    second = db.insert_halt(
        symbol="HMKTTST",
        reason_code="LUDP",
        halt_time=halt_time,
        halt_end_time=None,
        last_price=Decimal("4.0000"),
    )
    assert second is None


def test_different_reason_on_same_time_is_separate_halt(db: Database) -> None:
    db.try_acquire_leadership()
    halt_time = _now_utc()
    ludp = db.insert_halt("DUPECO", "LUDP", halt_time, None, None)
    t1 = db.insert_halt("DUPECO", "T1", halt_time, None, None)
    assert ludp is not None
    assert t1 is not None
    assert ludp != t1


def test_halt_kind_generated_column_classified(db: Database) -> None:
    assert DSN
    import psycopg

    db.try_acquire_leadership()
    halt_time = _now_utc()
    assert (
        db.insert_halt("KINDTST", "H10", halt_time, None, None) is not None
    )
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            "select halt_kind::text from public.halts "
            "where symbol = 'KINDTST' and halt_time = %s",
            (halt_time,),
        )
        (kind,) = cur.fetchone()  # type: ignore[misc]
    assert kind == "regulatory"
