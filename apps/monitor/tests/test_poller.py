"""Poller end-to-end with an in-memory fake DB + fake Polygon."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from haltmarket_monitor.db import Database
from haltmarket_monitor.metrics import MetricsState
from haltmarket_monitor.poller import Poller
from haltmarket_monitor.polygon import PolygonClient

if TYPE_CHECKING:
    from datetime import datetime


class _FakeDB(Database):
    def __init__(self) -> None:  # type: ignore[override]
        self.calls: list[tuple[str, str, datetime, datetime | None, Decimal | None]] = []
        self._dedup: set[tuple[str, str, datetime]] = set()
        self._is_leader = True  # tests always run as leader

    def connect(self) -> None:  # type: ignore[override]
        return

    def close(self) -> None:  # type: ignore[override]
        return

    def try_acquire_leadership(self) -> bool:  # type: ignore[override]
        return True

    def release_leadership(self) -> None:  # type: ignore[override]
        return

    def insert_halt(  # type: ignore[override]
        self,
        symbol: str,
        reason_code: str,
        halt_time: datetime,
        halt_end_time: datetime | None,
        last_price: Decimal | None,
    ) -> UUID | None:
        self.calls.append((symbol, reason_code, halt_time, halt_end_time, last_price))
        key = (symbol, reason_code, halt_time)
        if key in self._dedup:
            return None
        self._dedup.add(key)
        return uuid4()


class _FakePolygon(PolygonClient):
    def __init__(self) -> None:  # type: ignore[override]
        self.prices: dict[str, Decimal] = {
            "HMKT": Decimal("4.0000"),
            "ACME": Decimal("150.5000"),
        }

    def close(self) -> None:  # type: ignore[override]
        return

    def last_price(self, symbol: str) -> Decimal | None:  # type: ignore[override]
        return self.prices.get(symbol)


def _fetcher(payload: bytes) -> object:
    def f() -> bytes:
        return payload

    return f


def test_run_once_inserts_all_supported_halts(halts_rss_bytes: bytes) -> None:
    db = _FakeDB()
    metrics = MetricsState()
    poller = Poller(
        rss_fetcher=_fetcher(halts_rss_bytes),  # type: ignore[arg-type]
        db=db,
        polygon=_FakePolygon(),
        metrics=metrics,
    )
    inserted = poller.run_once()
    assert inserted == 4  # 4 supported reason codes in fixture
    assert {c[1] for c in db.calls} == {"LUDP", "T1", "T12", "H10"}


def test_dedup_skips_repeat_items_on_second_poll(halts_rss_bytes: bytes) -> None:
    db = _FakeDB()
    metrics = MetricsState()
    poller = Poller(
        rss_fetcher=_fetcher(halts_rss_bytes),  # type: ignore[arg-type]
        db=db,
        polygon=_FakePolygon(),
        metrics=metrics,
    )
    first = poller.run_once()
    second = poller.run_once()
    assert first == 4
    # In-memory dedup → zero DB calls on the second poll
    assert second == 0
    assert len(db.calls) == 4


def test_last_price_attached_when_polygon_has_it(halts_rss_bytes: bytes) -> None:
    db = _FakeDB()
    poller = Poller(
        rss_fetcher=_fetcher(halts_rss_bytes),  # type: ignore[arg-type]
        db=db,
        polygon=_FakePolygon(),
        metrics=MetricsState(),
    )
    poller.run_once()
    prices = {c[0]: c[4] for c in db.calls}
    assert prices["HMKT"] == Decimal("4.0000")
    assert prices["ACME"] == Decimal("150.5000")
    # Polygon fixture has no price for BIOX or PENNY — must be None
    assert prices["BIOX"] is None
    assert prices["PENNY"] is None


def test_metrics_track_seen_and_inserted(halts_rss_bytes: bytes) -> None:
    metrics = MetricsState()
    poller = Poller(
        rss_fetcher=_fetcher(halts_rss_bytes),  # type: ignore[arg-type]
        db=_FakeDB(),
        polygon=_FakePolygon(),
        metrics=metrics,
    )
    poller.run_once()
    assert metrics.halts_seen_total == {"volatility": 1, "news": 2, "regulatory": 1}
    assert metrics.halts_inserted_total == {"volatility": 1, "news": 2, "regulatory": 1}
    assert metrics.poll_cycles_total == 1
    assert metrics.poll_errors_total == 0


def test_rss_fetcher_error_records_metric() -> None:
    def boom() -> bytes:
        raise RuntimeError("network down")

    metrics = MetricsState()
    poller = Poller(
        rss_fetcher=boom,
        db=_FakeDB(),
        polygon=_FakePolygon(),
        metrics=metrics,
    )
    # Must not raise — errors are swallowed per cycle.
    inserted = poller.run_once()
    assert inserted == 0
    assert metrics.poll_errors_total == 1
    assert metrics.poll_cycles_total == 1


def test_metrics_render_produces_prometheus_format() -> None:
    metrics = MetricsState()
    metrics.record_inserted("volatility")
    metrics.record_poll_cycle(42.0)
    metrics.set_leader(True)
    rendered = metrics.render()
    assert "haltmarket_monitor_is_leader 1" in rendered
    assert 'haltmarket_monitor_halts_inserted_total{kind="volatility"} 1' in rendered
    assert "haltmarket_monitor_last_poll_ms 42" in rendered
