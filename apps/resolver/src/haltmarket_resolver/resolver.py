"""Per-tick resolver logic.

Kept separate from main.py so tests can drive `Resolver.run_once()`
directly with a fake Database + fake TradesFetcher without touching a
real psycopg or httpx client.

On each tick the resolver:

  1. Calls `list_resolvable_markets(cooldown, refund_deadline)` to get
     the set of locked markets ready for action.
  2. For each market whose `action == 'refund_timeout'`, calls
     `refund_market(halt_id, 'refund_timeout:no_polygon_data')`.
  3. For each market whose `action == 'resolve'`, queries Polygon
     starting at `halt_end_time` (or `locked_at` as fallback). If a
     reopen print is returned, calls `resolve_market(...)`.
  4. If Polygon returns nothing AND the refund deadline has passed
     during this tick, falls through to a refund.
  5. After every successful resolve, reads `ledger_global_sum()` — if
     non-zero, fires a CRITICAL alert and increments the
     `invariant_failures_total` metric.

The resolver is safe to restart mid-loop: both `resolve_market` and
`refund_market` are idempotent on the market_id (see migration 0005).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from decimal import Decimal

    from .alerts import AlertSink
    from .db import Database, ResolvableMarket
    from .metrics import MetricsState
    from .polygon import TradesFetcher

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolverConfig:
    post_reopen_cooldown_seconds: int
    opening_cross_window_seconds: int
    refund_deadline_minutes: int
    rehalt_extension_minutes: int


class Resolver:
    def __init__(
        self,
        *,
        db: Database,
        trades_fetcher: TradesFetcher,
        alerts: AlertSink,
        metrics: MetricsState,
        config: ResolverConfig,
    ) -> None:
        self._db = db
        self._trades = trades_fetcher
        self._alerts = alerts
        self._metrics = metrics
        self._config = config

    def run_once(self) -> int:
        """Run one tick. Returns the number of markets actioned this tick."""
        self._metrics.set_leader(self._db.is_leader)
        actioned = 0
        try:
            markets = self._db.list_resolvable_markets(
                cooldown_seconds=self._config.post_reopen_cooldown_seconds,
                refund_deadline_minutes=self._config.refund_deadline_minutes,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("list_resolvable_markets failed: %s", e)
            self._metrics.record_resolve_error()
            return 0

        for m in markets:
            try:
                if self._process_market(m):
                    actioned += 1
            except Exception as e:  # noqa: BLE001
                # Isolate failures — one bad market must not block the batch.
                # The next tick retries the same market because the RPCs are
                # idempotent and the market stays in 'locked' until resolved.
                logger.exception("resolver error on %s (%s): %s", m.symbol, m.market_id, e)
                self._metrics.record_resolve_error()

        return actioned

    def _process_market(self, m: ResolvableMarket) -> bool:
        if m.action == "refund_timeout":
            return self._refund(m, "refund_timeout:polygon_silent")
        if m.action != "resolve":
            logger.warning("unknown action %r for market %s", m.action, m.market_id)
            return False

        # `action == 'resolve'`: Polygon should have data by now.
        since = m.halt_end_time or m.locked_at
        if since is None:
            logger.warning(
                "market %s has neither halt_end_time nor locked_at; skipping",
                m.market_id,
            )
            return False

        reopen = self._trades.fetch_reopen(
            symbol=m.symbol,
            since=since,
            opening_cross_window_seconds=self._config.opening_cross_window_seconds,
        )
        if reopen is None:
            self._metrics.record_polygon_empty()
            # Check whether the refund deadline has crossed while we were
            # polling — if so, refund now rather than waiting for the next
            # tick.
            if self._locked_for_longer_than_refund_deadline(m):
                return self._refund(m, "refund_timeout:polygon_silent")
            logger.info("polygon had no reopen yet for %s (%s)", m.symbol, m.market_id)
            return False

        return self._resolve(m, reopen.price, reopen.traded_at, reopen.source, since)

    def _locked_for_longer_than_refund_deadline(self, m: ResolvableMarket) -> bool:
        if m.locked_at is None:
            return False
        deadline = m.locked_at + timedelta(minutes=self._config.refund_deadline_minutes)
        return datetime.now(UTC) >= deadline

    def _resolve(
        self,
        m: ResolvableMarket,
        reopen_price: Decimal,
        reopen_at: datetime,
        reopen_source: str,
        halt_end_time: datetime,
    ) -> bool:
        started = time.monotonic()
        result = self._db.resolve_market(
            halt_id=m.halt_id,
            reopen_price=reopen_price,
            reopen_at=reopen_at,
            reopen_source=reopen_source,
        )
        settlement_ms = (
            (datetime.now(UTC) - halt_end_time).total_seconds() * 1000.0
            if halt_end_time
            else (time.monotonic() - started) * 1000.0
        )
        self._metrics.record_resolve(settlement_ms)

        if result.idempotent_replay:
            logger.info("resolve replay market=%s (no-op)", result.market_id)
            return True

        logger.info(
            "resolved market=%s symbol=%s reopen=%s gross=%d fee=%d bonus=%d "
            "main=%d winner=%s settlement_ms=%.1f",
            result.market_id,
            m.symbol,
            reopen_price,
            result.gross_pool_micro,
            result.fee_micro,
            result.closest_bonus_micro,
            result.main_payout_pool_micro,
            result.closest_bonus_winner_user_id,
            settlement_ms,
        )

        # Post-resolve invariant check: Phase 5 brief calls for a CRITICAL
        # page if SUM != 0 after a resolve. The ledger is already balanced
        # by post_transfer's assertion, so this is belt-and-suspenders.
        try:
            global_sum = self._db.ledger_global_sum()
            if global_sum != 0:
                self._metrics.record_invariant_failure()
                self._alerts.critical(
                    f"SUM != 0 after resolve market={result.market_id} "
                    f"sum={global_sum}. Freeze place-bet and follow "
                    f"docs/runbook-drift.md."
                )
        except Exception as e:  # noqa: BLE001
            logger.exception("ledger_global_sum read failed after resolve: %s", e)

        if settlement_ms > 120_000:
            self._alerts.warn(
                f"resolve latency {settlement_ms:.0f}ms > 120s threshold "
                f"for market={result.market_id} symbol={m.symbol}"
            )

        return True

    def _refund(self, m: ResolvableMarket, reason: str) -> bool:
        result = self._db.refund_market(halt_id=m.halt_id, reason=reason)
        if result.idempotent_replay:
            logger.info("refund replay market=%s (no-op)", result.market_id)
            return True
        self._metrics.record_refund()
        self._alerts.info(
            f"refunded market={result.market_id} symbol={m.symbol} "
            f"bets={result.refunded_bet_count} "
            f"gross_refund_micro={result.gross_refund_micro} reason={reason}"
        )
        return True
