"""Database client for the resolver.

Responsibilities:
  * advisory-lock-based leader election — same pattern as Phase 2 monitor
    (`pg_try_advisory_lock` on a dedicated session)
  * listing locked markets due for resolve / refund via
    public.list_resolvable_markets(...)
  * calling public.resolve_market(...) once Polygon gives us a reopen price
  * calling public.refund_market(...) on 15-minute timeout

All three RPCs from migration 0005 are idempotent, so the resolver can be
killed and restarted anywhere in its loop without risking double-pay.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

import psycopg

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import datetime
    from decimal import Decimal

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvableMarket:
    """A locked market the resolver should act on this poll tick."""

    market_id: UUID
    halt_id: UUID
    symbol: str
    halt_end_time: datetime | None
    locked_at: datetime | None
    total_pool_micro: int
    action: str  # 'resolve' | 'refund_timeout'


@dataclass(frozen=True)
class ResolveResult:
    """Return from public.resolve_market — the receipt the resolver broadcasts."""

    market_id: UUID
    winning_bin_id: UUID
    gross_pool_micro: int
    fee_micro: int
    closest_bonus_micro: int
    closest_bonus_winner_user_id: UUID | None
    main_payout_pool_micro: int
    ledger_txn_id: UUID | None
    idempotent_replay: bool


@dataclass(frozen=True)
class RefundResult:
    market_id: UUID
    refunded_bet_count: int
    gross_refund_micro: int
    ledger_txn_id: UUID | None
    idempotent_replay: bool


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
        """Attempt to become the resolver leader. Idempotent."""
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
            logger.info("acquired resolver leader lock %s", self._lock_key)
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

    def list_resolvable_markets(
        self,
        *,
        cooldown_seconds: int,
        refund_deadline_minutes: int,
    ) -> list[ResolvableMarket]:
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute(
                """
                select market_id, halt_id, symbol, halt_end_time, locked_at,
                       total_pool_micro, action
                  from public.list_resolvable_markets(%s, %s)
                """,
                (cooldown_seconds, refund_deadline_minutes),
            )
            rows = cur.fetchall()
        return [
            ResolvableMarket(
                market_id=UUID(str(r[0])),
                halt_id=UUID(str(r[1])),
                symbol=str(r[2]),
                halt_end_time=r[3],
                locked_at=r[4],
                total_pool_micro=int(r[5]),
                action=str(r[6]),
            )
            for r in rows
        ]

    def resolve_market(
        self,
        halt_id: UUID,
        reopen_price: Decimal,
        reopen_at: datetime,
        reopen_source: str,
    ) -> ResolveResult:
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute(
                """
                select market_id, winning_bin_id, gross_pool_micro, fee_micro,
                       closest_bonus_micro, closest_bonus_winner_user_id,
                       main_payout_pool_micro, ledger_txn_id, idempotent_replay
                  from public.resolve_market(%s, %s, %s, %s)
                """,
                (halt_id, reopen_price, reopen_at, reopen_source),
            )
            row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"resolve_market returned no row for halt {halt_id}")
        return ResolveResult(
            market_id=UUID(str(row[0])),
            winning_bin_id=UUID(str(row[1])),
            gross_pool_micro=int(row[2]),
            fee_micro=int(row[3]),
            closest_bonus_micro=int(row[4]),
            closest_bonus_winner_user_id=UUID(str(row[5])) if row[5] else None,
            main_payout_pool_micro=int(row[6]),
            ledger_txn_id=UUID(str(row[7])) if row[7] else None,
            idempotent_replay=bool(row[8]),
        )

    def refund_market(self, halt_id: UUID, reason: str) -> RefundResult:
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute(
                """
                select market_id, refunded_bet_count, gross_refund_micro,
                       ledger_txn_id, idempotent_replay
                  from public.refund_market(%s, %s)
                """,
                (halt_id, reason),
            )
            row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"refund_market returned no row for halt {halt_id}")
        return RefundResult(
            market_id=UUID(str(row[0])),
            refunded_bet_count=int(row[1]),
            gross_refund_micro=int(row[2]),
            ledger_txn_id=UUID(str(row[3])) if row[3] else None,
            idempotent_replay=bool(row[4]),
        )

    def latest_rehalt_after(
        self,
        symbol: str,
        after: datetime,
        exclude_halt_id: UUID,
    ) -> datetime | None:
        """Most recent halt_time for `symbol` after `after`, excluding the
        given halt_id (which is the original halt backing the current market).

        Returns None when no such re-halt exists. Used to decide whether to
        extend the refund deadline on a timed-out market.
        """
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute(
                """
                select max(halt_time)
                  from public.halts
                 where symbol = %s
                   and halt_time > %s
                   and id <> %s
                """,
                (symbol, after, exclude_halt_id),
            )
            row = cur.fetchone()
        if not row or not row[0]:
            return None
        return row[0]

    def ledger_global_sum(self) -> int:
        """Invariant read used by the resolver's post-resolve sanity check."""
        self.connect()
        assert self._conn is not None
        with self._conn.cursor() as cur:
            cur.execute("select public.ledger_global_sum();")
            row = cur.fetchone()
        if row is None:
            return 0
        return int(row[0] or 0)

    def bulk_symbols(self, markets: Iterable[ResolvableMarket]) -> list[str]:
        """Convenience for logs / metrics."""
        return [m.symbol for m in markets]
