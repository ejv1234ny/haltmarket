"""Database client for the monitor.

Wraps psycopg with two concerns:
  * advisory-lock-based leader election (pg_try_advisory_lock on session)
  * idempotent halt insertion via public.insert_halt(...) RPC

A single connection holds the advisory lock for the process lifetime. If the
connection drops, the lock releases automatically — the standby then acquires
it on its next tick. This is the leader-election mechanism spelled out in
AGENTS.md §Phase 2.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol, runtime_checkable
from uuid import UUID

import psycopg

if TYPE_CHECKING:
    from datetime import datetime
    from decimal import Decimal

logger = logging.getLogger(__name__)


@runtime_checkable
class HaltInserter(Protocol):
    """Typing shim so main.py can swap in a fake in tests."""

    def insert_halt(
        self,
        symbol: str,
        reason_code: str,
        halt_time: datetime,
        halt_end_time: datetime | None,
        last_price: Decimal | None,
    ) -> UUID | None: ...


class Database:
    """Owns a single psycopg connection + the advisory leadership lock."""

    def __init__(self, dsn: str, leader_lock_key: int) -> None:
        self._dsn = dsn
        self._lock_key = leader_lock_key
        self._conn: psycopg.Connection | None = None
        self._is_leader = False

    @property
    def is_leader(self) -> bool:
        return self._is_leader

    def connect(self) -> None:
        if self._conn is not None and not self._conn.closed:
            return
        self._conn = psycopg.connect(self._dsn, autocommit=True)

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None
                self._is_leader = False

    def try_acquire_leadership(self) -> bool:
        """Attempt to become the leader. Idempotent — True once already leader."""
        if self._is_leader:
            return True
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute("select pg_try_advisory_lock(%s);", (self._lock_key,))
            row = cur.fetchone()
        got = bool(row and row[0])
        self._is_leader = got
        if got:
            logger.info("acquired leader lock %s", self._lock_key)
        return got

    def release_leadership(self) -> None:
        if not self._is_leader or self._conn is None:
            return
        try:
            with self._conn.cursor() as cur:
                cur.execute("select pg_advisory_unlock(%s);", (self._lock_key,))
        except psycopg.Error as e:
            logger.warning("error releasing leader lock: %s", e)
        finally:
            self._is_leader = False

    def insert_halt(
        self,
        symbol: str,
        reason_code: str,
        halt_time: datetime,
        halt_end_time: datetime | None,
        last_price: Decimal | None,
    ) -> UUID | None:
        """Call public.insert_halt(...). Returns new id or None on dedup."""
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute(
                "select public.insert_halt(%s, %s::halt_reason_code, %s, %s, %s);",
                (symbol, reason_code, halt_time, halt_end_time, last_price),
            )
            row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return UUID(str(row[0]))
