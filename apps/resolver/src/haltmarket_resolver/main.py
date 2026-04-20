"""Entrypoint for the resolution worker.

Process model mirrors the Phase 2 monitor:
  * One long-lived psycopg connection holds the advisory lock that marks
    this process as the resolver leader. The standby replica polls only
    when it wins the lock.
  * SIGINT / SIGTERM release the lock cleanly and exit 0.

Ship the skeleton mode so the Phase 0 smoke test still passes when
DATABASE_URL isn't set.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import time
from typing import TYPE_CHECKING

from haltmarket_resolver.alerts import build_alert_sink
from haltmarket_resolver.config import Settings
from haltmarket_resolver.db import Database
from haltmarket_resolver.metrics import MetricsServer, MetricsState
from haltmarket_resolver.polygon import PolygonTradesClient
from haltmarket_resolver.resolver import Resolver, ResolverConfig

if TYPE_CHECKING:
    from types import FrameType

logger = logging.getLogger("haltmarket_resolver")


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def run() -> int:
    """Entrypoint used by the console_script and the Phase 0 smoke test."""
    _configure_logging()
    if not os.environ.get("DATABASE_URL"):
        sys.stdout.write("haltmarket-resolver: skeleton mode (no DATABASE_URL)\n")
        return 0

    settings = Settings.from_env()
    return run_loop(settings)


def run_loop(settings: Settings) -> int:
    metrics = MetricsState()
    metrics_server = MetricsServer(metrics, settings.metrics_port)
    metrics_server.start()

    db = Database(settings.database_url, settings.leader_lock_key)
    polygon = PolygonTradesClient(settings.polygon_api_key)
    alerts = build_alert_sink(settings.discord_webhook_url)

    resolver = Resolver(
        db=db,
        trades_fetcher=polygon,
        alerts=alerts,
        metrics=metrics,
        config=ResolverConfig(
            post_reopen_cooldown_seconds=settings.post_reopen_cooldown_seconds,
            opening_cross_window_seconds=settings.opening_cross_window_seconds,
            refund_deadline_minutes=settings.refund_deadline_minutes,
            rehalt_extension_minutes=settings.rehalt_extension_minutes,
        ),
    )

    stop = _install_signal_handlers()

    logger.info(
        "starting resolver poll_interval=%.2fs metrics_port=%d refund_deadline=%dm",
        settings.poll_interval_seconds,
        settings.metrics_port,
        settings.refund_deadline_minutes,
    )

    try:
        while not stop.is_set():
            if not db.try_acquire_leadership():
                metrics.set_leader(False)
                time.sleep(settings.poll_interval_seconds)
                continue
            metrics.set_leader(True)
            resolver.run_once()
            time.sleep(settings.poll_interval_seconds)
    finally:
        db.release_leadership()
        db.close()
        polygon.close()
        metrics_server.stop()
    return 0


class _StopFlag:
    def __init__(self) -> None:
        self._flag = False

    def set(self) -> None:
        self._flag = True

    def is_set(self) -> bool:
        return self._flag


def _install_signal_handlers() -> _StopFlag:
    flag = _StopFlag()

    def _handler(_signum: int, _frame: FrameType | None) -> None:
        logger.info("received shutdown signal")
        flag.set()

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)
    return flag


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run())
