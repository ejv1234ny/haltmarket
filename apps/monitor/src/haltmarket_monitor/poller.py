"""The poll loop — ties feed + db + polygon + metrics together.

Kept separate from main.py so tests can drive a single poll iteration directly
without building a full runtime.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import httpx

from haltmarket_monitor.classify import halt_kind_for_reason
from haltmarket_monitor.feed import parse_feed

if TYPE_CHECKING:
    from collections.abc import Callable

    from haltmarket_monitor.db import Database
    from haltmarket_monitor.feed import HaltEvent
    from haltmarket_monitor.metrics import MetricsState
    from haltmarket_monitor.polygon import PolygonClient

logger = logging.getLogger(__name__)

# Small in-memory dedup cache so repeat items within a session don't hit DB.
# The persistent dedup story lives on `halts_dedup` in Postgres — this is just
# a performance cushion; the DB is still the source of truth.
_MEMO_CAP = 10_000


class Poller:
    def __init__(
        self,
        *,
        rss_fetcher: Callable[[], bytes],
        db: Database,
        polygon: PolygonClient,
        metrics: MetricsState,
    ) -> None:
        self._rss_fetcher = rss_fetcher
        self._db = db
        self._polygon = polygon
        self._metrics = metrics
        self._seen: set[tuple[str, str, str]] = set()

    def run_once(self) -> int:
        """Execute one poll iteration. Returns the number of new halts inserted."""
        start = time.monotonic()
        self._metrics.set_leader(self._db.is_leader)
        inserted = 0
        try:
            xml_bytes = self._rss_fetcher()
            events = parse_feed(xml_bytes)
            for ev in events:
                kind = halt_kind_for_reason(ev.reason_code)
                self._metrics.record_seen(kind)
                if self._seen_recently(ev):
                    continue
                if self._insert(ev, kind):
                    inserted += 1
        except Exception as e:  # noqa: BLE001
            self._metrics.record_poll_error()
            logger.exception("poll cycle failed: %s", e)
        finally:
            elapsed_ms = (time.monotonic() - start) * 1000.0
            self._metrics.record_poll_cycle(elapsed_ms)
        return inserted

    def _seen_recently(self, ev: HaltEvent) -> bool:
        key = (ev.symbol, ev.reason_code, ev.halt_time.isoformat())
        if key in self._seen:
            return True
        if len(self._seen) >= _MEMO_CAP:
            # Simple bounded cache — drop the oldest ~10% by rebuilding empty.
            # On RSS, items age out of the feed anyway, so this is safe.
            self._seen = set()
        self._seen.add(key)
        return False

    def _insert(self, ev: HaltEvent, kind: str) -> bool:
        last_price = self._polygon.last_price(ev.symbol)
        arrived = datetime.now(UTC)
        try:
            new_id = self._db.insert_halt(
                symbol=ev.symbol,
                reason_code=ev.reason_code,
                halt_time=ev.halt_time,
                halt_end_time=ev.halt_end_time,
                last_price=last_price,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("insert_halt failed for %s/%s: %s", ev.symbol, ev.reason_code, e)
            self._metrics.record_poll_error()
            return False
        if new_id is None:
            return False
        latency_ms = (datetime.now(UTC) - ev.halt_time).total_seconds() * 1000.0
        self._metrics.record_halt_to_db(latency_ms)
        self._metrics.record_inserted(kind)
        logger.info(
            "halt inserted id=%s symbol=%s reason=%s kind=%s halt_to_db_ms=%.1f "
            "arrived_at=%s",
            new_id,
            ev.symbol,
            ev.reason_code,
            kind,
            latency_ms,
            arrived.isoformat(),
        )
        return True


def http_rss_fetcher(url: str, *, timeout: float = 3.0) -> Callable[[], bytes]:
    """Build a fetcher closure reusing a persistent httpx client."""
    client = httpx.Client(timeout=timeout, follow_redirects=True)

    def fetch() -> bytes:
        resp = client.get(url, headers={"User-Agent": "haltmarket-monitor/0.2"})
        resp.raise_for_status()
        return resp.content

    return fetch
