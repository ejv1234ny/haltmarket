"""Monitor entrypoint — runs the poll loop with leader election + /metrics.

Process model:
  * One long-lived psycopg connection holds the advisory lock that marks this
    process as leader. A standby running the same image calls
    try_acquire_leadership() every tick; it only polls RSS when it wins.
  * If the leader's DB connection dies, Postgres auto-releases the lock and the
    standby picks up on its next tick (within `poll_interval_seconds`).
  * SIGINT / SIGTERM release the lock and exit 0.

No RSS polling happens on a standby, so the DB stays quiet even while the pair
is running hot-standby on Railway.
"""

from __future__ import annotations

import logging
import signal
import sys
import time
from typing import TYPE_CHECKING

from haltmarket_monitor.config import Settings

if TYPE_CHECKING:
    from types import FrameType
from haltmarket_monitor.db import Database
from haltmarket_monitor.metrics import MetricsServer, MetricsState
from haltmarket_monitor.poller import Poller, http_rss_fetcher
from haltmarket_monitor.polygon import PolygonClient

logger = logging.getLogger("haltmarket_monitor")


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def run() -> int:
    """Entrypoint used by the console_script and the Phase 0 smoke test.

    Phase 2 expands the Phase 0 skeleton into a full poll loop. The smoke test
    passes if DATABASE_URL isn't set — we short-circuit to the legacy behavior
    so CI for unrelated phases isn't blocked on env wiring.
    """
    import os

    _configure_logging()
    if not os.environ.get("DATABASE_URL"):
        sys.stdout.write("haltmarket-monitor: skeleton mode (no DATABASE_URL)\n")
        return 0

    settings = Settings.from_env()
    return run_loop(settings)


def run_loop(settings: Settings) -> int:
    metrics = MetricsState()
    metrics_server = MetricsServer(metrics, settings.metrics_port)
    metrics_server.start()

    db = Database(settings.database_url, settings.leader_lock_key)
    polygon = PolygonClient(settings.polygon_api_key)

    poller = Poller(
        rss_fetcher=http_rss_fetcher(settings.rss_url),
        db=db,
        polygon=polygon,
        metrics=metrics,
    )

    stop = _install_signal_handlers()

    logger.info(
        "starting monitor poll_interval=%.2fs rss=%s metrics_port=%d",
        settings.poll_interval_seconds,
        settings.rss_url,
        settings.metrics_port,
    )

    try:
        while not stop.is_set():
            if not db.try_acquire_leadership():
                metrics.set_leader(False)
                time.sleep(settings.poll_interval_seconds)
                continue
            metrics.set_leader(True)
            poller.run_once()
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
